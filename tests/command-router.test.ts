/**
 * 通用命令协议（CommandRouter）：参数保真、冒号子名、结构化结果与错误语义。
 * Router 只返回结构化处理结果，不直接给 Subject 发消息（宿主转交）。
 */

import { describe, expect, it } from "vitest";
import { CommandRouter } from "../src/extensions/commands.js";
import { ExtensionRegistry } from "../src/extensions/renderer-registry.js";

const registry = new ExtensionRegistry();
registry.registerCommand({
	name: "skill",
	description: "test",
	hasArgs: true,
	handler: (args) => ({ kind: "agent-input", text: `展开:${args}`, displayText: `/skill ${args}` }),
});
registry.registerCommand({
	name: "local",
	description: "test",
	handler: () => undefined,
});

describe("CommandRouter", () => {
	it("非命令返回 handled:false；裸 / 吞掉", async () => {
		const router = new CommandRouter(registry);
		expect(await router.dispatch("普通问题")).toEqual({ handled: false });
		expect(await router.dispatch("/")).toEqual({ handled: true });
	});

	it("参数保真：内部空白与引号原样到达 handler，不拆分重拼", async () => {
		const router = new CommandRouter(registry);
		const outcome = await router.dispatch('/skill  wood-house   建造  "两层 木屋"  ');
		expect(outcome).toEqual({
			handled: true,
			agentInput: {
				kind: "agent-input",
				text: '展开:wood-house   建造  "两层 木屋"',
				displayText: '/skill wood-house   建造  "两层 木屋"',
			},
		});
	});

	it('冒号子名并入参数：/skill:name args → handler("name args")', async () => {
		const router = new CommandRouter(registry);
		const outcome = await router.dispatch("/skill:wood-house 建造木屋");
		expect(outcome).toEqual({
			handled: true,
			agentInput: { kind: "agent-input", text: "展开:wood-house 建造木屋", displayText: "/skill wood-house 建造木屋" },
		});
	});

	it("本地管理命令返回 handled:true 且无 agentInput；未知命令抛错不落普通 Prompt", async () => {
		const router = new CommandRouter(registry);
		expect(await router.dispatch("/local")).toEqual({ handled: true });
		await expect(router.dispatch("/nope")).rejects.toThrow(/未知命令: \/nope/);
	});
});
