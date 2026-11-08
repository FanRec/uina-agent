/**
 * 连接级协议扩展的 Driver 实现：把只读端口交给 addon，并在连接退役时解除。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3.2。这里只做三件事：
 * 订阅（原始包 / 自定义通道 / 少量事件）、连接绑定的作用域判定、事实发布。
 * 不做事件总线、不做写入——写路径在 Runtime 的 BodyScope 上。
 */

import type { ConnectionFactSink, ConnectionPort } from "../contracts/protocol.js";
import type { JsonValue } from "../contracts/values.js";
import type { ClientHost } from "./client-host.js";
import type { MineflayerBot } from "./mineflayer/adapter.js";
import type { DriverProtocol } from "./mineflayer/protocol.js";

interface RawClient {
	on(event: string, listener: (...args: unknown[]) => void): void;
	removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ConnectionPortOptions {
	addonId: string;
	host: ClientHost;
	bot: MineflayerBot;
	protocol: DriverProtocol;
	facts: ConnectionFactSink;
	/** 代次判定：连接换代/关闭后返回 false，迟到的订阅与发布一律丢弃。 */
	isCurrent: () => boolean;
}

export interface DisposableConnectionPort extends ConnectionPort {
	/** 登记 attach 返回的释放函数（与订阅一起在连接结束时执行）。 */
	defer(off: () => void): void;
	dispose(): void;
}

export function createConnectionPort(options: ConnectionPortOptions): DisposableConnectionPort {
	const { addonId, host, bot, protocol, facts, isCurrent } = options;
	const client = bot._client as unknown as RawClient;
	const disposers = new Set<() => void>();
	const alive = (): boolean => isCurrent();
	const register = (off: () => void): (() => void) => {
		disposers.add(off);
		return () => {
			disposers.delete(off);
			off();
		};
	};
	const guarded = (work: (...args: unknown[]) => void) => {
		return (...args: unknown[]): void => {
			if (!alive()) return;
			try {
				work(...args);
			} catch (error) {
				console.warn(`[mc-addon:${addonId}] listener failed: ${String(error)}`);
			}
		};
	};
	/** 同步回调隔离：一个 addon 的异常不能打断底层订阅链上的其它订阅者。 */
	const safely = (work: () => void): void => {
		try {
			work();
		} catch (error) {
			console.warn(`[mc-addon:${addonId}] listener failed: ${String(error)}`);
		}
	};
	return {
		addonId,
		get connection(): string {
			return host.identity?.connection ?? "conn:unknown";
		},
		get incarnation(): string | null {
			return host.identity?.incarnation ?? null;
		},
		get version(): string {
			return protocol.version;
		},
		state: () => host.state,
		onPacket(name, handler) {
			const listener = guarded((payload) => handler(payload));
			client.on(name, listener);
			return register(() => client.removeListener(name, listener));
		},
		onCustomPayload(channel, handler) {
			// 订阅即声明：服务端只向已登记的通道投递，未登记时连回包都收不到。
			// 这是传输层订阅，不改变世界状态；真正的写入仍只在 BodyScope 内。
			// 已退役的连接不再向协议写入（registerChannels 在 ended 后会显式失败）。
			if (alive()) protocol.registerChannels([channel]);
			return register(
				protocol.onCustomPayload((notice) => {
					if (notice.channel !== channel) return;
					if (!alive()) return;
					safely(() => handler(notice.data));
				}),
			);
		},
		onEvent(name, handler) {
			const listener = guarded(() => handler());
			bot.on(name as never, listener as never);
			return register(() => bot.removeListener(name as never, listener as never));
		},
		publishFact(key: string, value: JsonValue, unknown?: string[]) {
			// 连接已换代的迟到消息不允许写进新连接的当前事实。
			if (!alive()) return;
			facts.publishAddonFact(addonId, key, value, unknown);
		},
		defer(off: () => void) {
			disposers.add(off);
		},
		dispose() {
			for (const off of [...disposers]) {
				disposers.delete(off);
				try {
					off();
				} catch {
					// 已断开的监听器移除失败无害。
				}
			}
		},
	};
}
