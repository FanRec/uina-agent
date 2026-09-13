import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
const reviewRoot=process.cwd();
if(process.platform==="win32"){const helper=createRequire(import.meta.url)(join(reviewRoot,`dist/src/ui/core/native/win32-${process.arch}.node`));assert.equal(typeof helper.isModifierPressed,"function");console.log(JSON.stringify({nativeLoaded:true,platform:process.platform,arch:process.arch}));}
for (const mode of ["tool-success", "builtin-image", "session-rewind", "truncated-provider"] as const) {
  const tempRoot = await mkdtemp(join(tmpdir(), "uina-direction-cli-"));
  const work = join(tempRoot, "work");
  const configRoot = join(tempRoot, "home");
  await mkdir(work, { recursive: true });
  await mkdir(join(configRoot, ".uina"), { recursive: true });
  let requests = 0;
  let sawToolResult = false;
  let sawImage = false;
		let sawRewind = false;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
  await writeFile(join(work, "pixel.png"), Buffer.from(png, "base64"));
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
						const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
      sawToolResult ||= parsed.messages?.some(m => m.role === "tool") ?? false;
						sawRewind ||= body.includes("会话回溯");
      sawImage ||= body.includes("data:image/png;base64," + png);
      res.writeHead(200, { "content-type": "text/event-stream" });
						const rewindCall = mode === "session-rewind" && requests === 2
								? {name:"session_rewind",arguments:JSON.stringify({targetId:JSON.parse(parsed.messages!.find(m=>m.role==="tool")!.content!).nodes[0].id,reason:"CLI roundtrip"})} : undefined;
      const deltas = mode === "truncated-provider"
        ? [{ choices: [{ delta: { content: "partial" } }] }]
								: rewindCall
										? [{choices:[{delta:{tool_calls:[{index:0,id:"rewind",function:rewindCall}]}}]}, {choices:[{delta:{},finish_reason:"tool_calls"}]}]
        : requests === 1
										? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: mode === "session-rewind" ? "session_list" : mode === "builtin-image" ? "read_image" : "get_time", arguments: mode === "builtin-image" ? '{"path":"pixel.png"}' : "{}" } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]
          : [{ choices: [{ delta: { content: "COMPILED_TOOL_OK" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
      res.end(deltas.map(d => `data: ${JSON.stringify(d)}\n\n`).join("") + (mode !== "truncated-provider" ? "data: [DONE]\n\n" : ""));
    });
  });
  try {
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    await writeFile(join(configRoot, ".uina/auth.json"), JSON.stringify({
      default: "review_fixture", thinkingLevel: "off", providers: {
								review_fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "review-fixture", modelContextWindow: 32768, thinkingLevels: ["off"] },
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
    const successMarker = stdout.includes("COMPILED_TOOL_OK");
    assert.equal(exitCode, mode !== "truncated-provider" ? 0 : 1);
    assert.equal(sawToolResult, mode !== "truncated-provider");
    assert.equal(sawImage, mode === "builtin-image");
				assert.equal(sawRewind, mode === "session-rewind");
				if (mode === "session-rewind") { assert.equal(requests,3); assert.ok(stdout.includes("[会话回溯]")); }
    // The marker is the observable end of the tool round-trip; printing it
    // without asserting it would let an empty-but-successful run pass.
    assert.equal(successMarker, mode !== "truncated-provider");
				console.log(JSON.stringify({ probe: "compiled-cli", mode, exitCode, requests, sawToolResult, sawImage, sawRewind, successMarker, errors: (stdout + stderr).split(/\r?\n/).filter(l => /错误|失败/.test(l)) }));
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    if (!resolve(tempRoot).startsWith(resolve(tmpdir()) + "\\uina-direction-cli-") && !resolve(tempRoot).startsWith(resolve(tmpdir()) + "/uina-direction-cli-")) throw new Error("Unexpected cleanup target");
    await rm(tempRoot, { recursive: true, force: true });
  }
}
