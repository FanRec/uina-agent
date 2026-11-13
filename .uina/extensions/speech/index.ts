import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import { createDeliveryPort } from "./delivery-port.js";
import { SpeechSession, type SpeechRuntimeNotice } from "./session.js";
import { createSpeechTool } from "./tool.js";
import { deliverRuntimeNotice, registerSpeechContext } from "./context.js";

export * from "./session.js";
export * from "./segmenter.js";
export * from "./delivery-port.js";
export * from "./preferences.js";
export * from "./tool.js";
export * from "./context.js";

/** Speech 块标签与表达文本的 owner 名称。 */
const SPEECH_BLOCK_NAME = "speech";
/** Playback fact → Speech 交付簿记的通知服务名（由 TTS 扩展调用）。 */
const PLAYBACK_FACT_SERVICE = "speech_delivery:on_playback";

/**
 * Speech 扩展（输出表达体系）：
 * - 注册 <speech> Block 语法；语义分句与 Cue 对齐归本扩展，物理执行归 TTS Driver。
 * - 公共 expression 观察处理器只同步推进语义状态、排入 Speech 自有异步队列；
 *   不等待 Bridge、文件或网络，不拖慢模型输出或 UI。
 * - 普通对话用 <speech>；speech 工具用于额外发声、停止、查询与持续静音。
 */
export default function activate(pi: ExtensionAPI): void {
	const session = new SpeechSession(
		pi,
		createDeliveryPort(
			(name, input) => pi.callService(name, input),
			(name) => Boolean(pi.hasService?.(name)),
		),
		(notice: SpeechRuntimeNotice) => deliverRuntimeNotice(pi, notice),
	);

	// 输出标签注册：Speech 文本块。cue Marker 由具身扩展注册（表现性线索属于身体域）。
	pi.registerOutputTag({ name: SPEECH_BLOCK_NAME, kind: "block" });
	pi.registerTool(createSpeechTool(session));
	registerSpeechContext(pi, session);

	// 交付簿记通知：Driver 的播放事实回推（trace 已在 TTS 层翻译为 utteranceId）。
	pi.registerService(PLAYBACK_FACT_SERVICE, async (input) => {
		const fact = input as { utteranceId?: string; kind?: string; segmentIndex?: number } | undefined;
		if (!fact || typeof fact.utteranceId !== "string") return { status: "not_started" };
		if (fact.kind !== "started" && fact.kind !== "completed" && fact.kind !== "failed") {
			return { status: "not_started" };
		}
		session.acceptPlaybackFact(fact.utteranceId, {
			traceId: "",
			segmentIndex: typeof fact.segmentIndex === "number" ? fact.segmentIndex : 0,
			kind: fact.kind,
		});
		return { status: "accepted" };
	});

	// 语义事件消费（同步、无 IO）：text/marker/block 生命周期 → Utterance 受理。
	// 只有本扩展注册并拥有的 speech 块文本进入发声；标签外的文字不自动朗读。
	const blockNames = new Map<string, string>(); // `${streamId}:${blockId}` → block name
	pi.on("expression", (event) => {
		const e = event.event;
		switch (e.kind) {
			case "block_start":
				if (e.name !== SPEECH_BLOCK_NAME) return;
				blockNames.set(`${e.streamId}:${e.blockId}`, e.name);
				session.acceptBlockStart(e.streamId, e.blockId);
				return;
			case "block_end": {
				if (e.name !== SPEECH_BLOCK_NAME) return;
				blockNames.delete(`${e.streamId}:${e.blockId}`);
				if (e.reason === "interrupted") session.interruptUtterance(e.streamId, e.blockId);
				else session.acceptBlockEnd(e.streamId, e.blockId);
				return;
			}
			case "text":
				if (e.scope?.name !== SPEECH_BLOCK_NAME) return;
				session.acceptSpeechText(e.streamId, e.scope.blockId, e.text);
				return;
			case "marker": {
				// Speech 内的 Marker 是该次声音的时间锚点；Speech 外的 Marker 归具身扩展。
				if (e.name !== "cue" || e.blockId === undefined) return;
				if (blockNames.get(`${e.streamId}:${e.blockId}`) !== SPEECH_BLOCK_NAME) return;
				session.acceptMarker(e.streamId, e.blockId, e.attributes);
				return;
			}
			default:
				return;
		}
	});

	// 生成侧中断与回合打断：只影响本轮仍在接受输入的 Utterance，不误杀独立 speech.say
	// 或旧已封口音频。output_interrupted 的流内中断由 block_end(interrupted) 语义承担。
	pi.on("turn_aborted", () => {
		session.abortOpenUtterances();
	});

	// 可用性阶段检查：未静音的声音能力从可用进入不可用时，每个故障阶段最多一次内部事件。
	pi.on("turn_start", () => {
		void session.refreshAvailability().catch(() => undefined);
	});
}
