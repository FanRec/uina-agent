/**
 * Driver 侧唯一的受控 custom_payload 写入口（设计包 §6.1）。
 *
 * Runtime 的 scoped port 已完成权限与身份检查，这里只做三件事：
 * 复核当前 Client 身份、真实写出 serverbound custom_payload、把这次派发记进
 * 现有 Effect Ledger。不新建 Payload 效果数据库，也不把"写出成功"写成服务端
 * 动作成功——没有 ACK 或观察证据时 completion 恒为 unknown。
 *
 * 写入发生在记录之前：customPayload 同步失败时它自己以 not_sent 抛错，
 * 不会留下"已派发"的假事实。记录若失败（writer fault）则如实以 sent 抛出，
 * 让本次效果以 unknown 进入结算，而不是静默成功。
 *
 * confirm() 是派发的补证路径：addon 拿到服务端 ACK 或真实观察证据后，追加一条
 * 同 effect 的 receipt 事实（completion=met, evidence=观察 ref），把结果从
 * unknown 升级成 met。没有证据就不该调用它——默认停在 unknown 才是诚实状态。
 */

import {
	PROTOCOL_WRITE_CONTRACT,
	type ProtocolDispatch,
	type ProtocolWriteDispatcher,
	type ProtocolWriteIdentity,
} from "../contracts/capabilities.js";
import type { DriverExecutionSink } from "../contracts/runtime.js";
import type { JsonValue, Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { ClientHost } from "./client-host.js";
import { nowIso } from "./execution.js";
import { protocolFor } from "./mineflayer/protocol.js";

export interface ProtocolDispatchOptions {
	host: ClientHost;
	/** 现有 Effect Ledger（RecordQueue 实现的 DriverExecutionSink）。 */
	sink: DriverExecutionSink;
	mintOp(): Ref;
	mintEff(): Ref;
	/** 组合根的执行域闸门：关闭/退役时不接受新副作用。 */
	assertActionAllowed(): void;
}

export function createProtocolWriteDispatcher(options: ProtocolDispatchOptions): ProtocolWriteDispatcher {
	const { host, sink, mintOp, mintEff, assertActionAllowed } = options;
	const identity = (): ProtocolWriteIdentity | null => {
		const current = host.identity;
		if (current == null || host.bot == null) return null;
		return { connection: current.connection, incarnation: current.incarnation };
	};
	return {
		identity,
		send(binding, channel, data): ProtocolDispatch {
			assertActionAllowed();
			const current = host.identity;
			const bot = host.bot;
			if (current == null || bot == null)
				throw callFailure({
					code: "DISCONNECTED",
					source: "environment",
					message: "custom payload requires a live client connection",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
			// Runtime 检查与真实写入之间可能换代；Driver 是写 socket 的一方，必须以自己为准。
			if (binding.connection !== current.connection || binding.incarnation !== current.incarnation)
				throw callFailure({
					code: "CONNECTION_RETIRED",
					source: "environment",
					message: "custom payload binding belongs to a retired connection or incarnation",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
			const effect = mintEff();
			const operation = mintOp();
			protocolFor(bot).customPayload(channel, data);
			const detail: JsonValue = {
				channel,
				bytes: typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength,
				run: binding.run,
				segment: binding.segment,
				call: binding.call,
				body: binding.body,
				connection: binding.connection,
				incarnation: binding.incarnation,
				acknowledged: false,
			};
			const ticket = sink.record({
				owner: binding.owner,
				effect,
				operation,
				contract: PROTOCOL_WRITE_CONTRACT,
				observedAt: nowIso(),
				kind: "dispatch",
				dispatch: "sent",
				completion: "unknown",
				evidence: [],
				detail,
			});
			if (ticket == null)
				throw callFailure({
					code: "EFFECT_RECORD_FAILED",
					source: "environment",
					message: "custom payload was sent but its dispatch fact could not be recorded",
					dispatch: "sent",
					effects: [effect],
					recoverable: false,
				});
			return { effect, operation };
		},
		confirm(binding, dispatch, evidence): void {
			const { effect, operation } = dispatch;
			// 确认发生在包已发出之后：任何失败都按 sent + 该 effect 报，不退回 not_sent。
			try {
				assertActionAllowed();
			} catch (error) {
				throw callFailure({
					code: "EXECUTION_DOMAIN_CLOSED",
					source: "environment",
					message: error instanceof Error ? error.message : String(error),
					dispatch: "sent",
					effects: [effect],
					recoverable: false,
				});
			}
			const current = host.identity;
			if (current == null || host.bot == null)
				throw callFailure({
					code: "DISCONNECTED",
					source: "environment",
					message: "custom payload confirmation requires a live client connection",
					dispatch: "sent",
					effects: [effect],
					recoverable: false,
				});
			if (binding.connection !== current.connection || binding.incarnation !== current.incarnation)
				throw callFailure({
					code: "CONNECTION_RETIRED",
					source: "environment",
					message: "custom payload confirmation belongs to a retired connection or incarnation",
					dispatch: "sent",
					effects: [effect],
					recoverable: false,
				});
			const ticket = sink.record({
				owner: binding.owner,
				effect,
				// 沿用派发时的 operation：存储层按首条事实固定身份，晚到证据不换绑。
				operation,
				contract: PROTOCOL_WRITE_CONTRACT,
				observedAt: nowIso(),
				kind: "receipt",
				dispatch: "sent",
				completion: "met",
				evidence: [...evidence],
				detail: {
					confirmed: true,
					evidenceCount: evidence.length,
					run: binding.run,
					segment: binding.segment,
					call: binding.call,
					body: binding.body,
					connection: binding.connection,
					incarnation: binding.incarnation,
				},
			});
			if (ticket == null)
				throw callFailure({
					code: "EFFECT_RECORD_FAILED",
					source: "environment",
					message: "custom payload was confirmed but its receipt fact could not be recorded",
					dispatch: "sent",
					effects: [effect],
					recoverable: false,
				});
		},
	};
}
