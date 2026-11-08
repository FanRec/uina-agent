/** 静态 ENV 接缝：只在世界适用时注入、可组合、停用即摘除、不写消息历史。 */
import { expect, test } from "vitest";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";

const BASE = "BASE SYSTEM PROMPT";
const GUIDE_A = "世界甲：环境认知甲";
const GUIDE_B = "世界乙：环境认知乙";

function makeHost() {
	const host = new ExtensionHost();
	const hooks = createRuntimeHooks(host);
	const pi = {
		subject: undefined,
		cwd: process.cwd(),
		isBusy: () => false,
		registerTool: () => () => {},
		on: () => () => {},
		onHook: (hook: string, handler: unknown, options?: { tail?: boolean }) =>
			host.onHook(hook as never, handler as never, options as never),
	} as never;
	const prepare = async (): Promise<{ systemPrompt?: string; messages?: readonly unknown[] }> =>
		(await hooks.turn.prepare({ prompt: "用户输入", systemPrompt: BASE })) as never;
	return { host, pi, prepare };
}

function activate(def: WorldDef, pi: never) {
	return new WorldActivation(def, {
		pi,
		runtime: { definition: def, enabled: true },
		worldName: def.name,
		notifyExposed() {},
	});
}

const definition = (name: string, guide: () => string | null): WorldDef => ({
	name,
	description: `probe ${name}`,
	actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
	environmentGuide: guide,
});

test("环境指引只在 getter 适用时注入本回合 systemPrompt，停用后 hook 摘除", async () => {
	const { pi, prepare } = makeHost();
	let applicable = false;
	const activation = activate(
		definition("mc", () => (applicable ? GUIDE_A : null)),
		pi,
	);
	await activation.start();
	try {
		// 没有活动会话：非 MC 任务不该背这段常驻文本。
		const idle = await prepare();
		expect(idle.systemPrompt).toBeUndefined();
		expect(idle.messages ?? []).toEqual([]);

		applicable = true;
		const active = await prepare();
		expect(active.systemPrompt).toContain(BASE);
		expect(active.systemPrompt).toContain("[world:mc:environment]");
		expect(active.systemPrompt).toContain(GUIDE_A);
		// 只改 systemPrompt，不注入用户/助手消息，也不落 Session。
		expect(active.messages ?? []).toEqual([]);

		// 每回合各自取一次，不累积、不重复追加。
		const again = await prepare();
		expect(again.systemPrompt).toBe(active.systemPrompt);
		expect(again.systemPrompt?.split("[world:mc:environment]").length).toBe(2);

		applicable = false;
		expect((await prepare()).systemPrompt).toBeUndefined();
	} finally {
		await activation.stop();
	}
	// scope 关闭后 handler 已注销，即便 getter 又适用也不再注入。
	applicable = true;
	expect((await prepare()).systemPrompt).toBeUndefined();
});

test("多个启用世界依次追加，互不覆盖，且与既有 turn.prepare 扩展可组合", async () => {
	const { host, pi, prepare } = makeHost();
	// 模拟 MCP 扩展：同样在 turn.prepare 追加 capability index。
	host.onHook(
		"turn.prepare",
		({ systemPrompt }: { systemPrompt: string }) => ({ systemPrompt: `${systemPrompt}\n\n[MCP INDEX]` }),
		{} as never,
	);
	const a = activate(
		definition("mc", () => GUIDE_A),
		pi,
	);
	const b = activate(
		definition("music", () => GUIDE_B),
		pi,
	);
	await a.start();
	await b.start();
	try {
		const result = await prepare();
		expect(result.systemPrompt).toContain(BASE);
		expect(result.systemPrompt).toContain("[MCP INDEX]");
		expect(result.systemPrompt).toContain("[world:mc:environment]");
		expect(result.systemPrompt).toContain("[world:music:environment]");
		expect(result.systemPrompt).toContain(GUIDE_A);
		expect(result.systemPrompt).toContain(GUIDE_B);
	} finally {
		await b.stop();
		await a.stop();
	}
});

test("静态 getter 抛错不打断回合准备链，也不污染其它世界", async () => {
	const { pi, prepare } = makeHost();
	const broken = activate(
		definition("broken", () => {
			throw new Error("getter failed");
		}),
		pi,
	);
	const healthy = activate(
		definition("healthy", () => GUIDE_B),
		pi,
	);
	await broken.start();
	await healthy.start();
	try {
		const result = await prepare();
		expect(result.systemPrompt).toContain(GUIDE_B);
		expect(result.systemPrompt).not.toContain("[world:broken:environment]");
	} finally {
		await healthy.stop();
		await broken.stop();
	}
});

test("未声明 environmentGuide 的世界不产生任何回合注入", async () => {
	const { pi, prepare } = makeHost();
	const plain: WorldDef = {
		name: "plain",
		description: "no guide",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
	};
	const activation = activate(plain, pi);
	await activation.start();
	try {
		expect((await prepare()).systemPrompt).toBeUndefined();
	} finally {
		await activation.stop();
	}
});
