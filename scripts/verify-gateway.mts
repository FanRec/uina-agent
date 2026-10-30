/**
 * verify:gateway——真进程 + 真 WebSocket + 真 provider fixture 的网关冒烟。
 *
 * 链路：spawn CLI（tsx 源码态，--gateway）→ 读 token 文件 → 真 ws 握手 hello →
 * 收快照 → 发 input.submit 意图 → fixture provider 回文本 → 断言事实流
 * （input_accepted 带网关归属、output 拼出标记、turn_end 收口）→ 静态页 200。
 * 需要先 pnpm build（静态页产物 dist/web）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const reviewRoot = process.cwd();
const hardDeadline = setTimeout(() => {
	console.error("verify:gateway 60s 超时熔断");
	process.exit(1);
}, 60_000);

const tempRoot = await mkdtemp(join(tmpdir(), "uina-gateway-"));
const work = join(tempRoot, "work");
const configRoot = join(tempRoot, "home");
await mkdir(work, { recursive: true });
await mkdir(join(configRoot, ".uina"), { recursive: true });
let server: import("node:http").Server | undefined;
let child: import("node:child_process").ChildProcess | undefined;
try {
	// ── provider fixture：一次请求，流式回标记文本 ──
	let requests = 0;
	server = createServer((req, res) => {
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "gateway-fixture" }] }));
			return;
		}
		if (req.url !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
		});
		req.on("end", () => {
			requests++;
			assert.ok(body.includes("来自远端的问候"), "provider 应收到远端意图的文本");
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				[
					{ choices: [{ delta: { content: "GATEWAY_" } }] },
					{ choices: [{ delta: { content: "ROUNDTRIP_OK" } }] },
					{ choices: [{ delta: {}, finish_reason: "stop" }] },
				]
					.map((delta) => `data: ${JSON.stringify(delta)}\n\n`)
					.join("") + "data: [DONE]\n\n",
			);
		});
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	const fixtureAddress = server?.address();
	if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("fixture address missing");
	await writeFile(
		join(configRoot, ".uina/auth.json"),
		JSON.stringify({
			default: "gateway_fixture",
			thinkingLevel: "off",
			providers: {
				gateway_fixture: {
					type: "openai-compatible",
					baseUrl: `http://127.0.0.1:${fixtureAddress.port}/v1`,
					apiKey: "local-test",
					model: "gateway-fixture",
					modelContextWindow: 32768,
					thinkingLevels: ["off"],
				},
			},
		}),
	);

	// ── 空闲端口 ──
	const portProbe = createServer();
	await new Promise<void>((r) => portProbe.listen(0, "127.0.0.1", r));
	const gatewayPort = (portProbe.address() as { port: number }).port;
	await new Promise<void>((r) => portProbe.close(() => r()));

	// ── spawn CLI（tsx 源码态）──
	const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
	child = spawn(
		process.execPath,
		[tsxCli, join(reviewRoot, "src/main.ts"), "--gateway", "--gateway-port", String(gatewayPort), "--no-session"],
		{
			cwd: work,
			env: { ...process.env, UINA_HOME: configRoot },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	let stdout = "";
	let stderr = "";
	child?.stdout?.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child?.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});

	const waitFor = async (probe: () => boolean, what: string, timeoutMs = 30_000): Promise<void> => {
		const start = Date.now();
		while (!probe()) {
			if (Date.now() - start > timeoutMs) throw new Error(`等待 ${what} 超时\nstdout:\n${stdout}\nstderr:\n${stderr}`);
			await new Promise((r) => setTimeout(r, 100));
		}
	};

	await waitFor(() => stdout.includes("多前端网关"), "网关启动横幅");
	const token = (await readFile(join(configRoot, ".uina/gateway-token"), "utf8")).trim();
	assert.ok(token.length >= 20, "token 应已落盘");

	// ── 真 ws 握手与全链路 ──
	const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const messages: Array<Record<string, unknown>> = [];
	let outputText = "";
	let sawInputAccepted = false;
	let sawTurnEnd = false;
	ws.on("message", (data) => {
		const message = JSON.parse(String(data)) as Record<string, unknown>;
		messages.push(message);
		if (message.kind === "fact") {
			const event = (message.record as { event: { type: string } }).event;
			if (event.type === "input_accepted") {
				const source = (event as { source?: { channel?: string; actor?: { label?: string } } }).source;
				if (source?.channel?.startsWith("gateway:")) sawInputAccepted = true;
			}
			if (event.type === "output_update" && (event as { channel?: string }).channel === "content") {
				outputText += (event as unknown as { text: string }).text;
			}
			if (event.type === "turn_end") sawTurnEnd = true;
		}
	});
	const send = (payload: unknown): void => ws.send(JSON.stringify(payload));
	send({ v: 1, kind: "hello", auth: token, client: "verify", capabilities: ["images"] });
	await waitFor(() => messages.some((m) => m.kind === "snapshot"), "快照");
	const snapshotView = messages.find((m) => m.kind === "snapshot")?.view as { session?: { modelName?: string } };
	assert.equal(snapshotView?.session?.modelName, "gateway-fixture", "快照应携带会话状态（模型名）");

	send({ v: 1, kind: "intent", intent: { type: "input.submit", text: "来自远端的问候", mode: "direct" } });
	await waitFor(() => sawTurnEnd, "turn_end 事实");
	assert.equal(outputText, "GATEWAY_ROUNDTRIP_OK", "事实流应拼出完整回文");
	assert.ok(sawInputAccepted, "input_accepted 应带网关归属（source.channel）");
	assert.ok(requests >= 1, "provider fixture 应被真实调用");

	// ── 静态页 ──
	const page = await fetch(`http://127.0.0.1:${gatewayPort}/`);
	assert.equal(page.status, 200, "静态页应可访问");
	assert.ok((await page.text()).includes("/web-client/main.js"), "index.html 应引用页面脚本");

	ws.close();
	child.kill();
	await new Promise<void>((r) => child?.once("close", () => r())).catch(() => {});
	console.log(
		JSON.stringify({
			probe: "gateway",
			gatewayPort,
			requests,
			facts: messages.filter((m) => m.kind === "fact").length,
			outputText,
			sawInputAccepted,
			pageOk: true,
		}),
	);
	process.exit(0);
} finally {
	clearTimeout(hardDeadline);
	// Windows 上 kill 只杀 tsx 包装进程，孙子进程握着 stdio 管道让本脚本不退出：
	// 按仓库惯例用 taskkill /T 杀整棵进程树。
	if (child?.pid !== undefined && process.platform === "win32") {
		await new Promise<void>((r) => {
			const killer = spawn("taskkill", ["/pid", String(child?.pid ?? 0), "/T", "/F"], { stdio: "ignore" });
			killer.on("close", () => r());
			killer.on("error", () => r());
		});
	} else {
		child?.kill();
	}
	// /F 即杀即生效；不 await close（被杀的孙子进程可能握着管道写端，close 永不触发）。
	await new Promise((r) => setTimeout(r, 200));
	await new Promise<void>((r) => server?.close(() => r()));
	if (!resolve(tempRoot).startsWith(resolve(tmpdir()))) throw new Error("Unexpected cleanup target");
	await rm(tempRoot, { recursive: true, force: true });
}
