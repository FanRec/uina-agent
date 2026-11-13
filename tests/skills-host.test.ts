/**
 * Skill 机制 Host 集成：真实请求链、命令展开、展示与模型正文分离、
 * 会话恢复、重载切换与重载准入门。
 * 领域逻辑细节在 skills.test.ts；这里只验证最终事实。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { UinaHost, type UinaHostOptions } from "../src/host/host.js";
import { projectInputMessage } from "../src/session/recovery.js";
import { Scenario } from "./harness/provider/scenario.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "uina-skills-host-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

const writeSkill = async (
	name: string,
	frontmatterLines: readonly string[],
	body = "标准正文",
	extraFiles: Record<string, string> = {},
): Promise<string> => {
	const dir = join(root, ".uina", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\n${frontmatterLines.join("\n")}\n---\n\n${body}\n`, "utf8");
	for (const [file, content] of Object.entries(extraFiles)) {
		await mkdir(join(dir, file, ".."), { recursive: true });
		await writeFile(join(dir, file), content, "utf8");
	}
	return dir;
};

const createHost = async (options: Partial<UinaHostOptions> = {}) => {
	const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 128_000 });
	scenario.fallback(() => [
		{ kind: "text", text: "ok" },
		{ kind: "finish", reason: "stop" },
	]);
	const host = await UinaHost.create({
		cwd: root,
		sessionPath: join(root, "session.jsonl"),
		model: scenario.model,
		stream: scenario.stream,
		workspaceTools: false,
		// 来源覆写：测试密封，不继承本机 ~/.agents/skills 等真实全局目录。
		skillSources: [{ ownerId: "workspace", directory: join(root, ".uina", "skills"), priority: 0 }],
		...options,
	});
	return { host, scenario };
};

const requestTexts = (calls: readonly { messages: readonly { role: string; content: unknown }[] }[]): string[] =>
	calls.flatMap((call) => call.messages.map((message) => String(message.content)));

describe("Skill Host 集成", () => {
	it("/skill 显式调用：模型收到展开正文；展示与 Journal 保留原始命令；回放同源", async () => {
		await writeSkill(
			"wood-house",
			["name: wood-house", "description: 用于建造木屋。"],
			"建造流程：先地基后屋顶。任务: $ARGUMENTS",
			{ "references/plan.md": "地基深度 1 格" },
		);
		const { host, scenario } = await createHost();
		const turnStarts: Array<{ userText: string }> = [];
		host.onEventRecord((record) => {
			if (record.event.type === "turn_start") turnStarts.push({ userText: record.event.userText });
		});
		try {
			await host.start();
			await host.submitOperatorCommand("/skill wood-house 建造一座两层木屋");
			await host.waitForIdle();

			// 真实模型请求：展开正文进 user content，原始命令不注入
			const userMessages = scenario.calls[0]!.messages.filter((m) => m.role === "user");
			const expanded = userMessages.map((m) => String(m.content)).join("\n");
			expect(expanded).toContain("建造流程：先地基后屋顶。任务: 建造一座两层木屋");
			expect(expanded).toContain("references/plan.md");
			expect(expanded).toContain("read_skill");
			expect(expanded).not.toContain("/skill wood-house");
			// Catalog 在同一次请求的固定 Guidance 中，且 read_skill 已声明
			const guidance = scenario.calls[0]!.messages.find((m) => m.context?.kind === "runtime.guidance");
			expect(String(guidance?.content)).toContain("<available_skills>");
			expect(scenario.calls[0]!.tools?.map((tool) => tool.function.name)).toContain("read_skill");

			// 实时展示与队列事实：操作者原始命令
			expect(turnStarts[0]!.userText).toBe("/skill wood-house 建造一座两层木屋");
		} finally {
			await host.dispose();
		}

		// Journal 恢复：input 记录带 displayText 与 data；模型正文在 message.content
		const reopened = await openJsonlSession(join(root, "session.jsonl"));
		try {
			const inputEntries = reopened.snapshot.entries.filter((entry) => entry.kind === "input");
			expect(inputEntries).toHaveLength(1);
			const input = (inputEntries[0] as Extract<(typeof inputEntries)[0], { kind: "input" }>).input;
			expect(input.displayText).toBe("/skill wood-house 建造一座两层木屋");
			expect(input.text).toContain("建造流程：先地基后屋顶");
			expect((input.data as { skill?: string }).skill).toBe("wood-house");

			// 恢复展示（transcript.loadSession 的输入 = projectInputMessage）：原始命令
			const projected = projectInputMessage(input);
			expect(projected.role === "user" && "displayText" in projected ? projected.displayText : undefined).toBe(
				"/skill wood-house 建造一座两层木屋",
			);
			expect(projected.content).toContain("建造流程：先地基后屋顶");
		} finally {
			await reopened.store.close();
		}
	});

	it("无 Skill：无 read_skill 工具、无 Catalog Guidance；请求与基线一致", async () => {
		const { host, scenario } = await createHost();
		try {
			await host.start();
			await host.submitText("普通问题", "direct");
			await host.waitForIdle();
			expect(scenario.calls[0]!.tools?.map((tool) => tool.function.name)).not.toContain("read_skill");
			expect(scenario.calls[0]!.messages.some((m) => m.context?.kind === "runtime.guidance")).toBe(false);
		} finally {
			await host.dispose();
		}
	});

	it("仅手动 Skill：无 Catalog 但保留 Reader；模型主动读正文被拒、附属资源可读", async () => {
		await writeSkill(
			"manual-only",
			["name: manual-only", "description: 手动专用。", "disable-model-invocation: true"],
			"手动正文",
			{ "references/steps.md": "第一步" },
		);
		const { host, scenario } = await createHost();
		try {
			await host.start();
			await host.submitText("触发装配", "direct");
			await host.waitForIdle();
			expect(
				String(scenario.calls[0]!.messages.find((m) => m.context?.kind === "runtime.guidance")?.content ?? ""),
			).not.toContain("<available_skills>");
			expect(scenario.calls[0]!.tools?.map((tool) => tool.function.name)).toContain("read_skill");

			// 模型主动加载正文 → 拒绝；附属资源 → 允许（供手动调用后的正文引用）
			const body = await host.runToolDirect("read_skill", { name: "manual-only" });
			expect(body.status).toBe("failed");
			expect(body.result).toContain("disable-model-invocation");
			const resource = await host.runToolDirect("read_skill", { name: "manual-only", resource: "references/steps.md" });
			expect(resource.status).toBe("succeeded");
			expect(resource.result).toContain("第一步");

			// 手动调用照常可用
			await host.submitOperatorCommand("/skill manual-only 修复");
			await host.waitForIdle();
			expect(requestTexts(scenario.calls).join("\n")).toContain("手动正文");
		} finally {
			await host.dispose();
		}
	});

	it("user-invocable: false：模型可读正文；/skill 明确失败不落普通 Prompt", async () => {
		await writeSkill(
			"model-only",
			["name: model-only", "description: 模型专用。", "user-invocable: false"],
			"模型专用正文",
		);
		const { host, scenario } = await createHost();
		try {
			await host.start();
			await host.submitText("触发装配", "direct");
			await host.waitForIdle();
			expect(
				String(scenario.calls[0]!.messages.find((m) => m.context?.kind === "runtime.guidance")?.content),
			).toContain("model-only");
			const body = await host.runToolDirect("read_skill", { name: "model-only" });
			expect(body.status).toBe("succeeded");
			await expect(host.submitOperatorCommand("/skill model-only 任务")).rejects.toThrow(/user-invocable: false/);
			// 失败不落普通 Prompt：没有新回合
			expect(scenario.calls).toHaveLength(1);
		} finally {
			await host.dispose();
		}
	});

	it("修改 Skill 后 /reload：目录与正文同步切换；卸载来源不留幽灵", async () => {
		await writeSkill("switching", ["name: switching", "description: 旧描述"], "旧正文");
		const { host } = await createHost();
		try {
			await host.start();
			const before = await host.inspectRequest();
			expect(String(before.projection.messages.find((m) => m.context?.kind === "runtime.guidance")?.content)).toContain(
				"旧描述",
			);

			await writeSkill("switching", ["name: switching", "description: 新描述"], "新正文");
			await host.reloadExtensions();
			const after = await host.inspectRequest();
			const guidance = String(after.projection.messages.find((m) => m.context?.kind === "runtime.guidance")?.content);
			expect(guidance).toContain("新描述");
			expect(guidance).not.toContain("旧描述");
			const body = await host.runToolDirect("read_skill", { name: "switching" });
			expect(body.result).toContain("新正文");
		} finally {
			await host.dispose();
		}
	});

	it("扩展资源根来源：激活后携带 skills/ 进入 Catalog；卸载后 /reload 撤下（不留幽灵）", async () => {
		// 本用例验证默认装配的第 7 行（扩展资源根）：取消来源覆写，用 UINA_HOME
		// 隔离用户全局目录（第 5 行）；断言只针对 ext-born，不依赖其余来源内容。
		const previousHome = process.env.UINA_HOME;
		process.env.UINA_HOME = join(root, "uina-home");
		await mkdir(join(root, "uina-home"), { recursive: true });
		const { host } = await createHost({ skillSources: undefined });
		try {
			await host.start();
			// 项目扩展自带独占资源根与其 skills/
			const extDir = join(root, ".uina", "extensions", "skillful");
			await mkdir(join(extDir, "skills", "ext-born"), { recursive: true });
			await writeFile(join(extDir, "index.ts"), "export default (): void => {};", "utf8");
			await writeFile(
				join(extDir, "skills", "ext-born", "SKILL.md"),
				"---\nname: ext-born\ndescription: 来自扩展资源根。\n---\n\n扩展正文\n",
				"utf8",
			);
			await host.reloadExtensions();
			const guidance = String(
				(await host.inspectRequest()).projection.messages.find((m) => m.context?.kind === "runtime.guidance")?.content,
			);
			expect(guidance).toContain("ext-born");

			// 卸载扩展后重载：Catalog 必须反映新有效集（收缩撤下失效来源）
			await rm(extDir, { recursive: true, force: true });
			await host.reloadExtensions();
			const after = String(
				(await host.inspectRequest()).projection.messages.find((m) => m.context?.kind === "runtime.guidance")?.content,
			);
			expect(after).not.toContain("ext-born");
		} finally {
			await host.dispose();
			if (previousHome === undefined) delete process.env.UINA_HOME;
			else process.env.UINA_HOME = previousHome;
		}
	});

	it("重载准入门：重载窗口内 Host.send 与扩展输入明确拒绝，不静默丢消息", async () => {
		// 项目扩展激活耗时 200ms：制造可观察的重载窗口
		const extDir = join(root, ".uina", "extensions", "slow");
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "index.ts"),
			"export default async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 200)); };",
			"utf8",
		);
		const { host } = await createHost();
		try {
			await host.start();
			const reloading = host.reloadExtensions();
			await new Promise((resolve) => setTimeout(resolve, 30));
			await expect(
				host.send({
					id: "gate-probe",
					mode: "followUp",
					source: { kind: "user", type: "operator" },
					text: "窗口内输入",
				}),
			).rejects.toThrow(/扩展正在重载/);
			await reloading;
			// 门关闭后同一输入照常受理
			await host.send({
				id: "after-probe",
				mode: "followUp",
				source: { kind: "user", type: "operator" },
				text: "重载后输入",
			});
			await host.waitForIdle();
			expect(host.snapshot().queue).toHaveLength(0);
		} finally {
			await host.dispose();
		}
	});

	it("Gateway skill.invoke：结构校验后经同一展开函数；畸形意图被拒", async () => {
		await writeSkill("gateway-skill", ["name: gateway-skill", "description: 网关调用。"], "网关正文 $ARGUMENTS");
		const { host, scenario } = await createHost();
		try {
			await host.start();
			await host.submitSkillInvocation("gateway-skill", "远端参数", "direct", {
				kind: "user",
				type: "operator",
				origin: "external",
				channel: "gateway:test",
			});
			await host.waitForIdle();
			const userMessages = scenario.calls[0]!.messages.filter((m) => m.role === "user");
			expect(userMessages.map((m) => String(m.content)).join("\n")).toContain("网关正文 远端参数");
			await expect(host.submitSkillInvocation("missing", "", "direct")).rejects.toThrow(/未知 Skill: missing/);
		} finally {
			await host.dispose();
		}
	});
});
