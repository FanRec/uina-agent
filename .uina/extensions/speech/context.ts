import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type { SpeechRuntimeNotice, SpeechSession } from "./session.js";

/**
 * Speech 的模型信息环境（输出表达体系 §7.1/§7.3）：全部经既有 Context Source /
 * Composer 装配，不新增事件总线、通知管理器或 Speech 专属 EventFrame。
 *
 * - Guidance：文件式静态说明（prompts/expression.md）。
 * - Observation（speech-limits）：只提供当前负面限制；正常可用返回 null，不写
 *   "语音正常/空闲"，也不无条件常驻。
 * - Observation（speech-now）：仅当前播放分句一行；纯函数读取最近一次可信播放事实，
 *   不播放时返回 null——正常播放进度与每句播放状态不常驻（保留理由：它是打断、
 *   抢话判断中"此刻仍在说什么"的最低成本事实；按需查询走 speech status 工具）。
 * - 内部 Runtime Input：只传达值得知道的变化；已发生的事实，过去式，按真实
 *   原因身份去重后经既有 submitInput 交付（Canonical 落 runtime-input）。
 */
export function registerSpeechContext(pi: ExtensionAPI, session: SpeechSession): void {
	const guidance = pi.provideContext({
		id: "expression-guide",
		kind: "guidance",
		file: "prompts/expression.md",
	});
	void guidance.catch((error) => pi.reportError(`[Speech] 表达指南注册失败: ${error instanceof Error ? error.message : String(error)}`));

	pi.provideContext({
		id: "speech-limits",
		kind: "observation",
		read: async () => {
			const line = await session.capabilityLine();
			if (line === null) return null;
			return {
				text: line,
				source: { type: "speech.capability", origin: "internal" },
			};
		},
	});

	pi.provideContext({
		id: "speech-now",
		kind: "observation",
		read: () => {
			// 纯读：无新数据采样、无队列消费、无状态修改；read() 被反复调用不改变快照。
			const line = session.currentSpeakingLine();
			if (line === null) return null;
			return {
				text: `正在说：「${line}」`,
				source: { type: "speech.playback", origin: "internal" },
			};
		},
	});
}

/** 内部 Runtime Input 的唯一交付出口：先形成事实，再申请交付（已有 Mailbox 受理、去重、持久化）。 */
export function deliverRuntimeNotice(pi: ExtensionAPI, notice: SpeechRuntimeNotice): void {
	void pi
		.submitInput({
			id: notice.identity,
			mode: "followUp",
			source: { kind: "runtime", origin: "internal", type: notice.type, ref: "speech" },
			text: notice.text,
		})
		.catch((error) => {
			// 提交失败按原 ID 做诊断上报，不生成新 ID 规避去重。
			pi.reportError(`[Speech] 交付事实通知未送达（${notice.type}）: ${error instanceof Error ? error.message : String(error)}`);
		});
}
