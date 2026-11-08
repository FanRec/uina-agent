/**
 * Driver 唯一拥有的 minecraft-protocol Client：先构造、后连接。
 *
 * 上游事实（minecraft-protocol 1.68.0，真实 Paper 1.21.11 首包探针取证）：
 * - `createClient` 的 offline 分支同步调用 `options.connect(client)`；
 * - `tcp_dns.js` 只在未提供 `options.connect` 时生成默认委托（含 SRV/DNS/stream）；
 * - 首包 `set_protocol` / `login_start` 由 socket 的 `connect` 事件触发，
 *   而该事件只在 `setSocket()` 之后发出。
 *
 * 因此这里提供自己的 `connect` 委托，只登记"稍后放行"，不建立 socket；
 * 放行时调用上游自己生成的默认委托，DNS/SRV/认证行为完全不变。
 * 不复制 TCP/Auth 协议栈，也不给 Addon 第二个 Client。
 */

import { createRequire } from "node:module";
import { callFailure } from "../../contracts/values.js";
import type { ClientOptions } from "./adapter.js";

const require = createRequire(import.meta.url);
const minecraftProtocol = require("minecraft-protocol") as {
	createClient(options: Record<string, unknown>): PendingProtocolClient;
};
const tcpDns = require("minecraft-protocol/src/client/tcp_dns.js") as (
	client: unknown,
	options: { host: string; port: number; connect?: (client: unknown) => void },
) => void;

/** 只声明 Driver 真正使用的 Client 面；其余上游能力不向 Addon 开放。 */
export interface PendingProtocolClient {
	readonly state: string;
	readonly socket: unknown;
	write(name: string, packet: unknown): void;
	on(event: string, listener: (...args: unknown[]) => void): void;
	removeListener(event: string, listener: (...args: unknown[]) => void): void;
	removeAllListeners(): void;
	end(reason?: string): void;
}

export interface PendingClient {
	client: PendingProtocolClient;
	/** 放行真实网络连接；只能调用一次。 */
	resume(): void;
	/** 事务回滚：已连接则关闭真实 Client，未连接则解除上游监听。幂等。 */
	abort(): void;
}

function failure(code: string, message: string): Error {
	return callFailure({ code, source: "environment", message, dispatch: "not_sent", effects: [], recoverable: false });
}

export function createPendingClient(opts: ClientOptions): PendingClient {
	// autoVersion 会在 createClient 期间独立发起 status ping 并置 wait_connect，
	// 与"放行前不产生任何网络活动"不兼容；固定组合要求显式版本。
	if (typeof opts.version !== "string" || opts.version.length === 0)
		throw failure("ADDON_PROTOCOL_VERSION_REQUIRED", "delayed connect requires an explicit minecraft protocol version");
	if (typeof tcpDns !== "function")
		throw failure("ADDON_PROTOCOL_SEAM_CHANGED", "minecraft-protocol/src/client/tcp_dns.js is no longer a function");

	const connector: { host: string; port: number; connect?: (client: unknown) => void } = {
		host: opts.host,
		port: opts.port,
	};
	tcpDns(null, connector);
	const defaultConnect = connector.connect;
	if (typeof defaultConnect !== "function")
		throw failure("ADDON_PROTOCOL_SEAM_CHANGED", "upstream did not produce a connect delegate");

	let resume: (() => void) | null = null;
	const client = minecraftProtocol.createClient({
		host: opts.host,
		port: opts.port,
		username: opts.username,
		version: opts.version,
		auth: "offline",
		connect: (created: PendingProtocolClient) => {
			resume = () => defaultConnect(created);
		},
	});
	if (resume == null) throw failure("ADDON_PROTOCOL_SEAM_CHANGED", "createClient did not invoke the connect delegate");

	let released = false;
	return {
		client,
		resume() {
			if (released) throw failure("ADDON_PROTOCOL_ALREADY_RELEASED", "pending client was already released");
			if (resume == null) throw failure("ADDON_PROTOCOL_ALREADY_CONNECTED", "connection was already released");
			const go = resume;
			resume = null;
			go();
		},
		abort() {
			if (released) return;
			released = true;
			resume = null;
			if (client.socket != null) client.end("addon bootstrap aborted");
			else client.removeAllListeners();
		},
	};
}
