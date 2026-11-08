/**
 * 连接级协议扩展的 Driver 实现：把只读端口交给 addon，并在连接退役时解除。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3.2。这里只做三件事：
 * 订阅（原始包 / 自定义通道 / 少量事件）、连接绑定的作用域判定、事实发布。
 * 不做事件总线、不做写入——写路径在 Runtime 的 BodyScope 上。
 *
 * 事实的采集身份在**事件到达时**定稿并放进同步上下文：回调（含异步续段）
 * 里的 publishFact 用的是当时那条连接/化身的身份，不是提交时临时读取当前身份。
 * 换代后旧异步结果由 FactsSource 按作用域拒绝，不会误标成新事实。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AddonFactOrigin,
	AddonFactPublicationOptions,
	ConnectionFactSink,
	ConnectionPort,
} from "../contracts/protocol.js";
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
	const collection = new AsyncLocalStorage<AddonFactOrigin>();
	const register = (off: () => void): (() => void) => {
		disposers.add(off);
		return () => {
			disposers.delete(off);
			off();
		};
	};
	/**
	 * 回调边界：捕获事件到达时的连接身份，并在该上下文中执行 addon 回调。
	 * AsyncLocalStorage 让回调的异步续段仍带着当时的采集身份；同步回调隔离保证
	 * 一个 addon 抛错不会打断底层订阅链上的其它订阅者。
	 */
	const deliver = (work: () => void): void => {
		if (!alive()) return;
		const identity = host.identity;
		if (identity == null) return;
		const origin: AddonFactOrigin = {
			connection: identity.connection,
			incarnation: identity.incarnation,
		};
		collection.run(origin, () => {
			try {
				work();
			} catch (error) {
				console.warn(`[mc-addon:${addonId}] listener failed: ${String(error)}`);
			}
		});
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
			const listener = (...args: unknown[]): void => deliver(() => handler(args[0]));
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
					deliver(() => handler(notice.data));
				}),
			);
		},
		onEvent(name, handler) {
			const listener = (): void => deliver(() => handler());
			bot.on(name as never, listener as never);
			return register(() => bot.removeListener(name as never, listener as never));
		},
		publishFact(key: string, value: JsonValue, publication: AddonFactPublicationOptions) {
			// 连接已换代的迟到消息不允许写进新连接的当前事实。
			if (!alive()) return;
			const origin = collection.getStore();
			if (origin == null)
				throw new Error(
					`ADDON_FACT_ORIGIN_MISSING: addon fact ${addonId}/${key} must be published from a connection event callback`,
				);
			facts.publishAddonFact(addonId, key, value, { ...publication, origin });
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
