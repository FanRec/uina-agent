import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import { VoiceSession } from "./session.js";
import { createVoiceTool } from "./tool.js";
import { VoicePerception } from "./perception.js";

export * from "./driver.js";
export * from "./events.js";
export * from "./session.js";
export * from "./tool.js";
export * from "./perception.js";
export * from "./preferences.js";

export default function activate(pi: ExtensionAPI): void {
	const session = new VoiceSession(pi);
	const perception = new VoicePerception();

	// record/resolve 串行化：异步服务调用按实际发生顺序生效，避免乱序让已恢复的
	// 故障再次出现（仅在这条服务链上串行）。
	let perceptionTail: Promise<unknown> = Promise.resolve();
	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const next = perceptionTail.then(work, work);
		perceptionTail = next.catch(() => undefined);
		return next;
	};

	(pi as ExtensionAPI & { registerService?: ExtensionAPI["registerService"] }).registerService?.(
		"voice_perception:record",
		async (input: { fact?: { kind?: string; summary?: string }; causeRef?: string; resolved?: boolean }) => {
			return serialized(async () => {
				if (input?.resolved && input.causeRef) {
					perception.resolve(input.causeRef);
					return { status: "resolved" };
				}
				const kind = input?.fact?.kind;
				const summary = input?.fact?.summary;
				if ((kind !== "delivery_failed" && kind !== "delivery_unknown") || typeof summary !== "string") {
					return { status: "not_started" };
				}
				const fact = { kind, summary } as const;
				return { status: "recorded", candidate: perception.record(fact, input.causeRef) };
			});
		},
	);

	// 未解决的声音事实经 observation Source 只读暴露（信息注入体系）：read 是纯读，
	// 不清除事实、不触发模型；事实随真实 resolve / 业务终止退出。
	pi.provideContext({
		id: "observation",
		kind: "observation",
		read: () => perception.observationValue(),
	});

	// 大模型门面工具：Uina 调用 voice action（speak/interrupt/status/manage）的唯一入口。
	pi.registerTool(createVoiceTool(session));
}
