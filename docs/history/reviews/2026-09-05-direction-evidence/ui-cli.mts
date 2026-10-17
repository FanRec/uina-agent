import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InteractiveTUI } from "../../../../src/ui/tui.js";
import { TranscriptContainer } from "../../../../src/ui/components/transcript/transcript.js";
import { UIHost } from "../../../../src/ui/ui-host.js";

const reviewRoot = process.cwd();
const statuses = ["succeeded", "failed", "cancelled", "unknown", "not_started"] as const;
const projections = [];
for (const status of statuses) {
  const tui = new InteractiveTUI();
  tui.render({ type: "turn_start", n: 1, text: "review fixture" });
  tui.render({ type: "tool_start", name: "fixture_tool", args: {}, callId: "c" });
  tui.render({ type: "tool_done", name: "fixture_tool", result: status, status, callId: "c" });
  tui.render({ type: "turn_end", n: 1 });
  const live = tui.host.transcript.getHistory().flatMap(t => t.items).find(i => i.kind === "tool");
  const restored = new TranscriptContainer();
  restored.loadHistory([
    { role: "user", content: "review fixture" },
    { role: "assistant", content: "", tool_calls: [{ id: "c", name: "fixture_tool", args: {} }] },
    { role: "tool", tool_call_id: "c", content: status, status },
  ]);
  const replay = restored.getHistory().flatMap(t => t.items).find(i => i.kind === "tool");
  projections.push({ input: status, live: live?.kind === "tool" ? live.status : null, replay: replay?.kind === "tool" ? replay.status : null });
  tui.close();
}
console.log(JSON.stringify({ probe: "tool-status-projection", projections }));

const ui = new UIHost();
ui.setThinkingLevels(["off", "low"]);
ui.setReasoningEffort("high");
console.log(JSON.stringify({ probe: "ui-capability", declared: ["off", "low"], acceptedEffort: ui.getReasoningEffort() }));
console.log(JSON.stringify({ probe: "compiled-native-asset", sourceExists: existsSync(join(reviewRoot, "src/ui/core/native/win32-x64.node")), builtExists: existsSync(join(reviewRoot, "dist/src/ui/core/native/win32-x64.node")) }));

for (const mode of ["tool-success", "truncated-provider"] as const) {
  const tempRoot = await mkdtemp(join(tmpdir(), "uina-direction-cli-"));
  const work = join(tempRoot, "work");
  const configRoot = join(tempRoot, "home");
  await mkdir(work, { recursive: true });
  await mkdir(join(configRoot, ".uina"), { recursive: true });
  let requests = 0;
  let sawToolResult = false;
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "review-fixture" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      requests++;
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
      sawToolResult ||= parsed.messages?.some(m => m.role === "tool") ?? false;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const deltas = mode === "truncated-provider"
        ? [{ choices: [{ delta: { content: "partial" } }] }]
        : requests === 1
          ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "get_time", arguments: "{}" } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]
          : [{ choices: [{ delta: { content: "COMPILED_TOOL_OK" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
      res.end(deltas.map(d => `data: ${JSON.stringify(d)}\n\n`).join("") + (mode === "tool-success" ? "data: [DONE]\n\n" : ""));
    });
  });
  try {
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    await writeFile(join(configRoot, ".uina/auth.json"), JSON.stringify({
      default: "review_fixture", thinkingLevel: "off", providers: {
        review_fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "review-fixture", modelContextWindow: 4096, thinkingLevels: ["off"] },
      },
    }));
    const child = spawn(process.execPath, [join(reviewRoot, "dist/src/main.js")], {
      cwd: work,
      env: { ...process.env, UINA_HOME: configRoot, UINA_ONESHOT_MSG: "review fixture" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += String(c); });
    child.stderr.on("data", c => { stderr += String(c); });
    const exitCode = await new Promise<number | null>((r, reject) => { child.on("error", reject); child.on("close", r); });
    console.log(JSON.stringify({ probe: "compiled-cli", mode, exitCode, requests, sawToolResult, successMarker: stdout.includes("COMPILED_TOOL_OK"), errors: (stdout + stderr).split(/\r?\n/).filter(l => /错误|失败/.test(l)) }));
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    if (!resolve(tempRoot).startsWith(resolve(tmpdir()) + "\\uina-direction-cli-") && !resolve(tempRoot).startsWith(resolve(tmpdir()) + "/uina-direction-cli-")) throw new Error("Unexpected cleanup target");
    await rm(tempRoot, { recursive: true, force: true });
  }
}
