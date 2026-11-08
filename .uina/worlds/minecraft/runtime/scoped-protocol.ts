/**
 * 每次 BodyScope 专属的受控协议写端口（设计包 §6.1）。
 *
 * 端口在创建时绑定 Call / Lease / Connection / Incarnation，send() 逐次复核，
 * 不依赖"创建时检查过一次"。guard 复用引擎现有的 assertLease(call, lease)
 * （内部已含 assertCallLive → assertActionAllowed）；身份一致性在此按绑定值比较。
 * 所有失败都是 dispatch=not_sent：过了期的端口绝不能碰真实网络。
 *
 * 派发默认只到"已发出"（Driver 侧记 dispatch=sent / completion=unknown）。
 * confirm() 是唯一把它结算成 met 的路径：必须带观察证据，且只能确认本端口
 * 自己发出的 effect——没有 ACK 或观察证据就保持 unknown，不给虚假 met。
 */

import type {
	ProtocolDispatch,
	ProtocolWriteBinding,
	ProtocolWriteDispatcher,
	ProtocolWritePort,
} from "../contracts/capabilities.js";
import type { CallFailure, Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";

export interface ScopedProtocolWriteOptions {
	dispatcher: ProtocolWriteDispatcher;
	binding: ProtocolWriteBinding;
	/** 现有 assertLease(call, lease)：逐次校验 Call 活性、Lease 关闭与子 Call 委托。 */
	guard(): void;
}

function notSent(code: string, message: string): never {
	throw callFailure({
		code,
		source: "capability",
		message,
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

/** 确认失败时包已经发出去了：如实报 sent + 该 effect，不退回 not_sent。 */
function confirmFailed(code: string, message: string, effect: Ref): never {
	throw callFailure({
		code,
		source: "capability",
		message,
		dispatch: "sent",
		effects: [effect],
		recoverable: false,
	});
}

export function createScopedProtocolWrite(options: ScopedProtocolWriteOptions): ProtocolWritePort {
	const { dispatcher, binding, guard } = options;
	const sent = new Map<Ref, ProtocolDispatch>();
	const assertCurrent = (): void => {
		const current = dispatcher.identity();
		if (current == null) notSent("DISCONNECTED", "custom payload requires a live client connection");
		if (
			binding.connection == null ||
			binding.incarnation == null ||
			current.connection !== binding.connection ||
			current.incarnation !== binding.incarnation
		)
			notSent("CONNECTION_RETIRED", "custom payload scope belongs to a retired connection or incarnation");
	};
	return {
		send(channel: string, data: string | Uint8Array): Ref {
			// 保存引用后调用 / Body 退出 / 子 Call 委托 / 停止或安全打断都在这里拦下。
			guard();
			assertCurrent();
			const dispatch = dispatcher.send(binding, channel, data);
			sent.set(dispatch.effect, dispatch);
			return dispatch.effect;
		},
		confirm(effect: Ref, evidence: readonly Ref[]): void {
			const dispatch = sent.get(effect);
			if (dispatch == null)
				confirmFailed("EFFECT_NOT_OWNED", `effect ${effect} was not dispatched by this scope`, effect);
			if (evidence.length === 0)
				confirmFailed(
					"EFFECT_UNCONFIRMED",
					"confirm requires observation evidence; omit it to keep the result unknown",
					effect,
				);
			try {
				guard();
				assertCurrent();
			} catch (error) {
				const failure = error as Partial<CallFailure>;
				confirmFailed(
					typeof failure.code === "string" ? failure.code : "CONTROL_INVALID",
					error instanceof Error ? error.message : String(error),
					effect,
				);
			}
			dispatcher.confirm(binding, dispatch, evidence);
		},
	};
}
