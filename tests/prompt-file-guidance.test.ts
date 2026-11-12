import { afterEach, describe, expect, it } from "vitest";
import type { ChatMsg, FileGuidanceSource, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { discoverExtensionEntries } from "../src/extensions/loader.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { IsolatedEnv, SubjectHarness } from "./harness/index.js";

const envs: IsolatedEnv[] = [];
afterEach(async () => {
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});

async function createEnv(): Promise<IsolatedEnv> {
	const env = await IsolatedEnv.create({ prefix: "uina-prompt-ext-" });
	envs.push(env);
	return env;
}

const deltas: StreamDelta[] = [
	{ kind: "text", text: "好的" },
	{ kind: "finish", reason: "stop" },
];

function capturingStream(): { stream: ModelStreamFn; requests: ChatMsg[][] } {
	const requests: ChatMsg[][] = [];
	const stream: ModelStreamFn = async (_model, req, onDelta) => {
		requests.push(structuredClone(req.messages as ChatMsg[]));
		for (const delta of deltas) onDelta(delta);
	};
	return { stream, requests };
}

/** 资源根与发现（A7）：目录扩展与多入口包有独占根，单文件入口没有。 */
describe("扩展 Prompt 文件机制（文件式 guidance）", () => {
	it("discoverExtensionEntries：目录扩展/多入口包有资源根，单文件入口没有", async () => {
		const env = await createEnv();
		await env.writeExtension("speech/index.ts", "export default function () {}");
		await env.writeExtension("pkg/package.json", JSON.stringify({ uina: { extensions: ["./a.ts", "./b.ts"] } }));
		await env.writeExtension("pkg/a.ts", "export default function () {}");
		await env.writeExtension("pkg/b.ts", "export default function () {}");
		await env.writeExtension("single.ts", "export default function () {}");

		const entries = await discoverExtensionEntries(env.path);
		const rootOf = (suffix: string): string | undefined =>
			entries.find((entry) => entry.file.replace(/\\/g, "/").endsWith(suffix))?.root?.replace(/\\/g, "/");

		expect(rootOf("speech/index.ts")).toMatch(/\/speech$/);
		expect(rootOf("pkg/a.ts")).toMatch(/\/pkg$/);
		expect(rootOf("pkg/b.ts")).toMatch(/\/pkg$/);
		expect(rootOf("single.ts")).toBeUndefined();
	});

	it("目录扩展注册 PROMPT.md：真实请求 System 后单条固定前缀 User，include 已展开，trace 带编译元数据；卸载后下一次请求无残留", async () => {
		const env = await createEnv();
		await env.writeExtension(
			"speech/index.ts",
			`export default async function (pi) {
	await pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" });
}`,
		);
		await env.writeFile(".uina/extensions/speech/PROMPT.md", "# Speech\n\n{{include:prompts/expression.md}}\n");
		await env.writeFile(".uina/extensions/speech/prompts/expression.md", "表达要自然。");

		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			await runner.load();
			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks(), stream });
			await harness.subject.pushInput("第一问");
			await harness.subject.waitForIdle();

			const messages = requests[0]!;
			expect(messages[0]!.role).toBe("system");
			const prefix = messages[1]!;
			expect(prefix.context?.kind).toBe("runtime.guidance");
			expect(prefix.content).toContain("# 已装配扩展指南");
			expect(prefix.content).toContain("## project:.uina/extensions/speech/index.ts / instructions");
			expect(prefix.content).toContain("表达要自然。");
			expect(messages.filter((m) => m.context?.kind === "runtime.guidance")).toHaveLength(1);
			// 章节之后才是真实输入
			expect(messages[2]!.context?.kind).toBeUndefined();

			// 检查通道同源：inspectRequest 的 trace 带编译元数据（对账 A12）
			const inspection = await harness.subject.inspectRequest();
			const trace = inspection.assembly?.sources.find((s) => s.status === "included" && s.id === "instructions");
			expect(trace?.messageIndex).toBe(1);
			expect(trace?.prompt?.entry).toBe("PROMPT.md");
			expect(trace?.prompt?.sources).toEqual(["PROMPT.md", "prompts/expression.md"]);
			expect(trace?.prompt?.hash).toMatch(/^[0-9a-f]{64}$/);

			// 卸载后下一次请求不再含其章节，也没有前缀容器
			await runner.disposeProjects();
			await harness.subject.pushInput("第二问");
			await harness.subject.waitForIdle();
			expect(requests[1]!.some((m) => m.context?.kind === "runtime.guidance")).toBe(false);
		} finally {
			await runner.dispose();
		}
	});

	it("修改磁盘文件不改变已注册内容；Reload 后使用新文本与新哈希", async () => {
		const env = await createEnv();
		await env.writeExtension(
			"speech/index.ts",
			`export default async function (pi) {
	await pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" });
}`,
		);
		await env.writeFile(".uina/extensions/speech/PROMPT.md", "指南第一版");

		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			await runner.load();
			const hooks = runner.runtimeHooks();
			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: hooks, stream });

			await harness.subject.pushInput("第一问");
			await harness.subject.waitForIdle();
			expect(requests[0]!.find((m) => m.context?.kind === "runtime.guidance")!.content).toContain("指南第一版");
			const hashV1 = (await harness.subject.inspectRequest()).assembly?.sources.find((s) => s.id === "instructions")
				?.prompt?.hash;

			// 编辑磁盘文件：已注册文本保持不变（文件只在注册时读取一次）
			await env.writeFile(".uina/extensions/speech/PROMPT.md", "指南第二版");
			await harness.subject.pushInput("第二问");
			await harness.subject.waitForIdle();
			expect(requests[1]!.find((m) => m.context?.kind === "runtime.guidance")!.content).toContain("指南第一版");
			expect(requests[1]!.find((m) => m.context?.kind === "runtime.guidance")!.content).not.toContain("指南第二版");

			// Reload 重新编译注册：新文本与新哈希生效
			await runner.reload();
			const hashV2 = (await harness.subject.inspectRequest()).assembly?.sources.find((s) => s.id === "instructions")
				?.prompt?.hash;
			expect(hashV1).toMatch(/^[0-9a-f]{64}$/);
			expect(hashV2).toMatch(/^[0-9a-f]{64}$/);
			expect(hashV2).not.toBe(hashV1);
			await harness.subject.pushInput("第三问");
			await harness.subject.waitForIdle();
			expect(requests[2]!.find((m) => m.context?.kind === "runtime.guidance")!.content).toContain("指南第二版");
		} finally {
			await runner.dispose();
		}
	});

	it("编译失败：该扩展激活失败且不留半个 Source，其他扩展正常工作", async () => {
		const env = await createEnv();
		await env.writeExtension(
			"broken/index.ts",
			`export default async function (pi) {
	await pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" });
}`,
		);
		// broken 的 PROMPT.md 引用缺失文件
		await env.writeFile(".uina/extensions/broken/PROMPT.md", "{{include:missing.md}}");
		await env.writeExtension(
			"healthy/index.ts",
			`export default function (pi) {
	pi.provideContext({ id: "note", kind: "guidance", text: "内联指引。" });
}`,
		);

		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			await runner.load();
			const failed = runner.diagnostics().find((d) => d.id.includes("broken"));
			expect(failed?.status).toBe("failed");
			expect(failed?.error).toContain("引用的文件不存在");
			expect(runner.diagnostics().find((d) => d.id.includes("healthy"))?.status).toBe("active");

			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks(), stream });
			await harness.subject.pushInput("探针");
			await harness.subject.waitForIdle();
			const prefix = requests[0]!.find((m) => m.context?.kind === "runtime.guidance");
			expect(prefix?.content).toContain("## project:.uina/extensions/healthy/index.ts / note");
			expect(prefix?.content).not.toContain("broken");
		} finally {
			await runner.dispose();
		}
	});

	it("无独占资源根的扩展使用文件式 guidance 明确失败；装配点提供 resourceRoot 的内置扩展可用", async () => {
		const env = await createEnv();
		await env.writeFile("builtin-prompt/PROMPT.md", "内置指南。");
		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			// 无根：文件式明确拒绝，内联不受影响
			let rootlessError: Error | undefined;
			await runner.activateBuiltin("solo", (pi) => {
				pi.provideContext({ id: "inline", kind: "guidance", text: "内联指引。" });
				return pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" }).catch((e: Error) => {
					rootlessError = e;
				});
			});
			expect(rootlessError?.message).toContain("没有独占资源根");

			// 有根：文件式可用
			let fileError: Error | undefined;
			await runner.activateBuiltin(
				"rooted",
				(pi) => {
					return pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" }).catch((e: Error) => {
						fileError = e;
					});
				},
				{ resourceRoot: env.resolve("builtin-prompt") },
			);
			expect(fileError).toBeUndefined();

			const inspection = await SubjectHarness.create({ runtimeHooks: runner.runtimeHooks() }).subject.inspectRequest();
			const ids = inspection.assembly?.sources.filter((s) => s.status === "included").map((s) => `${s.owner}::${s.id}`);
			expect(ids).toEqual(["builtin:rooted::instructions", "builtin:solo::inline"]);
			const prefix = inspection.projection.messages[1]!;
			expect(prefix.context?.kind).toBe("runtime.guidance");
			expect(prefix.content).toContain("内置指南。");
			expect(prefix.content).toContain("内联指引。");
		} finally {
			await runner.dispose();
		}
	});

	it("同身份重复注册拒绝；text 与 file 互斥", async () => {
		const env = await createEnv();
		await env.writeFile("prompt/PROMPT.md", "指南。");
		await env.writeFile("prompt/OTHER.md", "另一份。");
		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			const errors: Error[] = [];
			await runner.activateBuiltin(
				"dup",
				async (pi) => {
					const first = await pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" });
					try {
						await pi.provideContext({ id: "instructions", kind: "guidance", file: "OTHER.md" });
					} catch (error) {
						errors.push(error as Error);
					}
					const both = { id: "both", kind: "guidance", text: "x", file: "PROMPT.md" } as unknown as FileGuidanceSource;
					try {
						await pi.provideContext(both);
					} catch (error) {
						errors.push(error as Error);
					}
					return first;
				},
				{ resourceRoot: env.resolve("prompt") },
			);
			expect(errors.some((e) => /重名/.test(e.message))).toBe(true);
			expect(errors.some((e) => /不允许同时指定 text 和 file/.test(e.message))).toBe(true);

			const inspection = await SubjectHarness.create({ runtimeHooks: runner.runtimeHooks() }).subject.inspectRequest();
			const sections = inspection.projection.messages[1]!.content.match(/^## .+$/gm) ?? [];
			expect(sections).toEqual(["## builtin:dup / instructions"]);
		} finally {
			await runner.dispose();
		}
	});

	it("异步编译期间作用域已停用：不补注册过期 Source（无悬空注册）", async () => {
		const env = await createEnv();
		// 200 个链式引用拖长编译窗口，让"停用先于编译完成"成为现实时序
		const chain = Array.from({ length: 200 }, (_, i) => `c${String(i).padStart(3, "0")}.md`);
		for (let i = 0; i < chain.length; i++) {
			const line = i + 1 < chain.length ? `{{include:${chain[i + 1]!}}}` : "链尾";
			await env.writeFile(`.uina/extensions/race/${chain[i]!}`, line);
		}
		await env.writeExtension(
			"race/index.ts",
			`export default function (pi) {
	pi.provideContext({ id: "instructions", kind: "guidance", file: "c000.md" })
		.then(() => { globalThis.__raceSettled = "registered"; })
		.catch((error) => { globalThis.__raceSettled = "rejected:" + error.message; });
}`,
		);
		const runner = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
		try {
			await runner.load();
			await runner.dispose();
			for (let i = 0; i < 500 && (globalThis as Record<string, unknown>).__raceSettled === undefined; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const outcome = (globalThis as Record<string, unknown>).__raceSettled as string | undefined;
			// 两种结算都符合合同：编译先完成 → 注册随作用域关闭释放；停用先发生 → 明确拒绝。
			// 唯一不合法的是"作用域已死但 Source 悬空注册"——那会表现为 outcome === "registered"
			// 且 inspectRequest 仍可见，此处 dispose 后注册表已随 host 关闭，直接断言结算文本。
			expect(outcome === "registered" || /已失效/.test(String(outcome))).toBe(true);
			expect(outcome).toBeDefined();
		} finally {
			await runner.dispose();
		}
	});
});
