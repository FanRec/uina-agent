/**
 * 预连接阶段的协议装配：把全部 Addon 的 install() 贡献落到同一个 Client 上。
 *
 * 真实机制（minecraft-protocol 1.68.0 源码取证）：
 * - client.js 对每个入站包同时 emit 'packet' 与 emit(parsed.metadata.name, data, meta)，
 *   所以按包名订阅即可拿到解码后的包，client.state 给出当前协议阶段；
 * - 通道声明在 play 阶段是 `minecraft:register`（Protocol12111.registerChannels 会在
 *   进入 play 后补发）；configuration 阶段没有这个原版包，不伪造一个——具体加载器
 *   的协商由基础包用 onPayload/replyPayload 自己完成；
 * - 握手回复写的是本连接的同一个 Client，不是第二个 Client，也不是游戏 Effect。
 *
 * 装配事务：installAll 中任一扩展失败（含 claim 冲突）立刻移除本连接已注册的全部
 * 处理器并释放低层插件，主错误原样抛出。装配结束后冻结，saved boot 引用不能在
 * play 阶段偷偷追加注册。
 */

import type { PhaseContext, ProtocolBootstrap, ProtocolExtension, ProtocolPhase } from "../contracts/protocol.js";
import { callFailure, type Ref } from "../contracts/values.js";
import type { PendingProtocolClient } from "./mineflayer/pending-client.js";
import type { DriverProtocol } from "./mineflayer/protocol.js";

type ChannelPhase = "configuration" | "play";

const CHANNEL_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const MAX_CUSTOM_PAYLOAD = 32767;

function failure(code: string, message: string): Error {
	return callFailure({ code, source: "environment", message, dispatch: "not_sent", effects: [], recoverable: false });
}

export interface ProtocolAssemblyOptions {
	client: PendingProtocolClient;
	protocol: DriverProtocol;
	minecraftVersion: string;
	connection: Ref;
	/** 连接代次判定：换代后旧装配不再派发，也不再回复。 */
	isCurrent: () => boolean;
}

export interface ProtocolAssembly extends ProtocolBootstrap {
	/** 按依赖拓扑顺序装配全部扩展；任一失败即回滚本连接已注册的处理器。 */
	installAll(extensions: readonly ProtocolExtension[]): void;
	/** 装配完成后冻结；放行连接之前调用。 */
	finish(): void;
	/** 解除全部订阅与低层插件；幂等。 */
	dispose(): void;
}

export function createProtocolAssembly(options: ProtocolAssemblyOptions): ProtocolAssembly {
	const { client, protocol, minecraftVersion, connection, isCurrent } = options;
	const owners = new Map<string, string>();
	const declared = new Set<string>();
	const listeners: { event: string; listener: (...args: unknown[]) => void }[] = [];
	const closers: (() => void)[] = [];
	let currentAddon = "*";
	let frozen = false;
	let disposed = false;

	const key = (phase: string, resource: string): string => `${phase}\0${resource}`;
	const phaseNow = (): string => client.state;
	const alive = (): boolean => !disposed && isCurrent();

	const assertOpen = (): void => {
		if (disposed)
			throw failure("ADDON_PROTOCOL_ASSEMBLY_DISPOSED", "protocol assembly belongs to a retired connection");
		if (frozen)
			throw failure("ADDON_PROTOCOL_ASSEMBLY_FROZEN", "protocol contributions must be installed before connect");
	};

	const writePayload = (channel: string, data: Uint8Array): void => {
		if (!CHANNEL_PATTERN.test(channel))
			throw failure("ADDON_PROTOCOL_CHANNEL_INVALID", `${JSON.stringify(channel)} is not a ResourceLocation`);
		if (!(data instanceof Uint8Array))
			throw failure("ADDON_PROTOCOL_PAYLOAD_INVALID", "custom payload data must be Uint8Array");
		if (data.byteLength > MAX_CUSTOM_PAYLOAD)
			throw failure(
				"ADDON_PROTOCOL_PAYLOAD_INVALID",
				`custom payload is ${data.byteLength} bytes; limit is ${MAX_CUSTOM_PAYLOAD}`,
			);
		client.write("custom_payload", { channel, data: Buffer.from(data) });
	};

	const context = (phase: ProtocolPhase): PhaseContext => ({
		phase,
		connection,
		replyPacket(packetName, packet) {
			if (!alive()) throw failure("ADDON_PROTOCOL_CONNECTION_RETIRED", "reply refused: connection is retired");
			if (phaseNow() !== phase)
				throw failure("ADDON_PROTOCOL_PHASE_EXPIRED", `reply refused: ${phase} packet arrived in ${phaseNow()}`);
			client.write(packetName, packet);
		},
		replyPayload(channel, data) {
			if (!alive()) throw failure("ADDON_PROTOCOL_CONNECTION_RETIRED", "reply refused: connection is retired");
			if (phase !== "configuration")
				throw failure("ADDON_PROTOCOL_PHASE_FORBIDDEN", "replyPayload is limited to the configuration phase");
			if (phaseNow() !== "configuration")
				throw failure("ADDON_PROTOCOL_PHASE_EXPIRED", `reply refused: configuration ended in ${phaseNow()}`);
			writePayload(channel, data);
		},
	});

	const listen = (event: string, listener: (...args: unknown[]) => void): void => {
		client.on(event, listener);
		listeners.push({ event, listener });
	};

	/** 一个 Addon 的回调异常不能打断同一包上的其它订阅者。 */
	const safely = (addonId: string, work: () => void): void => {
		try {
			work();
		} catch (error) {
			console.warn(`[mc-addon:${addonId}] protocol handler failed: ${String(error)}`);
		}
	};

	const claimResource = (phase: ProtocolPhase | "preconnect", resource: string): void => {
		const id = key(phase, resource);
		const owner = owners.get(id);
		if (owner != null && owner !== currentAddon)
			throw failure(
				"ADDON_PROTOCOL_CONFLICT",
				`${owner} and ${currentAddon} both claim ${phase}:${resource}; the connection was not opened`,
			);
		owners.set(id, currentAddon);
	};

	const declareReceive = (phase: ChannelPhase, channel: string): void => {
		if (!CHANNEL_PATTERN.test(channel))
			throw failure("ADDON_PROTOCOL_CHANNEL_INVALID", `${JSON.stringify(channel)} is not a ResourceLocation`);
		const id = key(phase, channel);
		if (declared.has(id)) return;
		declared.add(id);
		// play 阶段的服务端只向已登记的通道投递；未进 play 时由 Driver 排队补发。
		// configuration 阶段没有 minecraft:register，不能靠自造包冒充协商。
		if (phase === "play") protocol.registerChannels([channel]);
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		for (const { event, listener } of listeners.splice(0)) client.removeListener(event, listener);
		for (const off of closers.splice(0).reverse()) {
			try {
				off();
			} catch (error) {
				console.warn(`[mc-addon] low-level protocol plugin cleanup failed: ${String(error)}`);
			}
		}
		owners.clear();
		declared.clear();
	};

	const assembly: ProtocolAssembly = {
		minecraftVersion,
		connection,
		onPacket(phase, name, handler) {
			assertOpen();
			const addonId = currentAddon;
			// client.js 对每个包 emit(metadata.name, data, meta)：第一个参数就是解码后的包。
			listen(name, (packet: unknown) => {
				if (!alive() || phaseNow() !== phase) return;
				safely(addonId, () => handler(packet, context(phase)));
			});
		},
		onPayload(phase, channel, handler) {
			assertOpen();
			// 订阅即声明接收；普通通道允许多个订阅者。
			declareReceive(phase, channel);
			const addonId = currentAddon;
			listen("custom_payload", (packet: unknown) => {
				const value = packet as { channel?: unknown; data?: unknown } | null;
				if (value?.channel !== channel || !(value.data instanceof Uint8Array)) return;
				if (!alive() || phaseNow() !== phase) return;
				const bytes = value.data;
				safely(addonId, () => handler(bytes, context(phase)));
			});
		},
		declareReceive,
		claim: claimResource,
		installLowLevel(name, install) {
			assertOpen();
			claimResource("preconnect", name);
			const addonId = currentAddon;
			let off: void | (() => void);
			try {
				// 受信任底层插件接触的是 Driver 拥有的同一个 Client，只在预连接阶段安装。
				off = install(client);
			} catch (error) {
				throw failure("ADDON_PROTOCOL_LOWLEVEL_FAILED", `${addonId}: ${name} failed to install: ${String(error)}`);
			}
			if (typeof off === "function") closers.push(off);
		},
		installAll(extensions) {
			assertOpen();
			try {
				for (const extension of extensions) {
					if (extension.install == null) continue;
					currentAddon = extension.id;
					extension.install(assembly);
				}
			} catch (error) {
				dispose();
				throw error;
			} finally {
				currentAddon = "*";
			}
		},
		finish() {
			frozen = true;
		},
		dispose,
	};
	return assembly;
}
