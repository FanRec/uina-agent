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

  (pi as ExtensionAPI & { registerService?: ExtensionAPI["registerService"] }).registerService?.("voice_perception:record", async (input: { fact?: unknown; causeRef?: string }) => {
    const fact = input?.fact as import("./perception.js").VoiceFact | undefined;
    if (!fact || typeof fact.summary !== "string") return { status: "not_started" };
    return { status: "recorded", candidate: perception.record(fact, input.causeRef) };
  });

  // 大模型门面工具：Uina 调用 voice action（speak/interrupt/status/manage）的唯一入口。
  pi.registerTool(createVoiceTool(session));

  pi.on("turn_start", (event) => {
    perception.setTurnCause(event.inputRefs ?? []);
  });
  pi.on("output_start", (event) => {
    if (event.channel === "content") perception.consume(event.streamId);
  });
  pi.onHook("turn.transformContext", (projection) => ({ projection: perception.transform(projection) }));

  pi.on("turn_aborted", () => {
    void session.interrupt();
  });
}
