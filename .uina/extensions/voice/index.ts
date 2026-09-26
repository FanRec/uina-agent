import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import { VoiceSession } from "./session.js";
import { createVoiceTool } from "./tool.js";

export * from "./driver.js";
export * from "./events.js";
export * from "./session.js";
export * from "./tool.js";

export default function activate(pi: ExtensionAPI): void {
  const session = new VoiceSession(pi);

  // 大模型门面工具：Uina 调用 voice action（mute/unmute/interrupt/status）的唯一入口。
  pi.registerTool(createVoiceTool(session));

  // 本扩展**不**投影任何交付视口。它只权威拥有"发声意志"（要不要出声）。
  // "说到哪句、还有多少排队、上一条断在哪"由事实拥有者 tts 扩展投影
  // （见 .uina/extensions/tts 的 turn.transformContext 钩子）。
  // 旧版的单轮退火断点视口已删除：同一事实两处记账，必然互相打脸。

  pi.on("turn_aborted", () => {
    void session.interrupt();
  });
}
