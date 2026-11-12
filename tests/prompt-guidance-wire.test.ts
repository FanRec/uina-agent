import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import { anthropicMessages, anthropicSystem } from "../src/ai/providers.js";
import type { ChatMsg, Model, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { IsolatedEnv, SubjectHarness } from "./harness/index.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

const envs: IsolatedEnv[] = [];
afterEach(async () => {
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});

const sse = (events: string[]): string => events.map((event) => `data: ${event}\n\n`).join("");

async function endpoint(handler: (body: string) => void): Promise<string> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			handler(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				sse([
					JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
					JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
					"[DONE]",
				]),
			);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe("扩展指南固定前缀的 Provider Wire（A11）", () => {
	it("OpenAI 兼容真实 Wire 保留 System→扩展指南→历史的语义顺序，前缀正文完整", async () => {
		const env = await IsolatedEnv.create({ prefix: "uina-guidance-wire-" });
		envs.push(env);
		await env.writeExtension(
			"speech/index.ts",
			`export default async function (pi) {
	await pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" });
}`,
		);
		await env.writeFile(".uina/extensions/speech/PROMPT.md", "语音要轻声。\n\n{{include:prompts/more.md}}");
		await env.writeFile(".uina/extensions/speech/prompts/more.md", "补充：不要打断。");

		let receivedBody = "";
		const base = await endpoint((body) => {
			receivedBody = body;
		});
		const provider = createOpenAIProvider("wire-test", { baseUrl: base, apiKey: "test" });
		const model: Model = { id: "m", name: "m", providerId: "wire-test", contextWindow: 128_000 };

		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			await runner.load();
			const stream: ModelStreamFn = (m, req, onDelta, signal) => provider.stream(m, req, onDelta, signal);
			const harness = SubjectHarness.create({ model, stream, runtimeHooks: runner.runtimeHooks() });
			await harness.subject.pushInput("第一问");
			await harness.subject.waitForIdle();
			await harness.subject.pushInput("第二问");
			await harness.subject.waitForIdle();
		} finally {
			await runner.dispose();
		}

		const payload = JSON.parse(receivedBody) as { messages: { role: string; content: string }[] };
		// 第二问的请求：历史（第一问/答）+ 新输入，扩展指南仍固定在 system 之后
		const roles = payload.messages.map((m) => m.role);
		expect(roles[0]).toBe("system");
		expect(payload.messages[1]!.role).toBe("user");
		expect(payload.messages[1]!.content).toContain("# 已装配扩展指南");
		expect(payload.messages[1]!.content).toContain("## project:.uina/extensions/speech/index.ts / instructions");
		expect(payload.messages[1]!.content).toContain("语音要轻声。");
		expect(payload.messages[1]!.content).toContain("补充：不要打断。");
		// 语义顺序：指南 User 在 system 之后、任何历史之前；不存在伪造的 Assistant
		const guidanceIndex = payload.messages.findIndex((m) => m.content.includes("已装配扩展指南"));
		const historyIndex = payload.messages.findIndex((m) => m.content.includes("第一问"));
		expect(guidanceIndex).toBe(1);
		expect(historyIndex).toBeGreaterThan(guidanceIndex);
		expect(roles.filter((role) => role === "assistant")).toHaveLength(1); // 仅第一问的真实答复
		// 绝对文件路径与内部诊断不进模型正文
		expect(receivedBody).not.toContain(env.path.replace(/\\/g, "\\\\"));
	});

	it("Anthropic 映射保留 System→扩展指南→历史语义顺序（system 提出、其余按序成 user 消息）", async () => {
		const semantic: ChatMsg[] = [
			{ role: "system", content: "系统提示" },
			{
				role: "user",
				content: "# 已装配扩展指南\n以下内容由运行时装配…\n\n## ext / instructions\n指南正文",
				context: { kind: "runtime.guidance" },
			},
			{ role: "user", content: "第一问" },
			{ role: "assistant", content: "第一答" },
			{ role: "user", content: "第二问" },
		];
		const req = {
			messages: semantic,
			providerHooks: (await import("../src/runtime/noop.js")).NO_RUNTIME_HOOKS.provider,
		} as unknown as import("../src/core/types.js").ModelRequest;
		expect(anthropicSystem(req)).toBe("系统提示");
		const wire = anthropicMessages(req) as { role: string; content: unknown }[];
		// system 走独立字段；指南是第一条 user 文本消息（字符串内容），历史随后，不伪造 Assistant
		expect(wire[0]!.role).toBe("user");
		expect(wire[0]!.content).toContain("已装配扩展指南");
		expect(wire[0]!.content).toContain("指南正文");
		expect(wire.some((m) => m.content === "第一问" || JSON.stringify(m.content).includes("第一问"))).toBe(true);
		const assistantCount = wire.filter((m) => m.role === "assistant").length;
		expect(assistantCount).toBe(1);
	});

	it("SSE 流真实完成：finish 收尾且无协议错误", async () => {
		// 上例已覆盖完整往返；这里固化流协议事实（finish delta 抵达）。
		const deltas: StreamDelta[] = [];
		const base = await endpoint(() => {});
		const provider = createOpenAIProvider("wire-probe", { baseUrl: base, apiKey: "test" });
		await provider.stream(
			{ id: "m", name: "m", providerId: "wire-probe", contextWindow: 4096 },
			{
				messages: [{ role: "user", content: "hi" }],
				providerHooks: (await import("../src/runtime/noop.js")).NO_RUNTIME_HOOKS.provider,
			},
			(delta) => deltas.push(delta),
		);
		expect(deltas.at(-1)).toEqual({ kind: "finish", reason: "stop" });
	});
});
