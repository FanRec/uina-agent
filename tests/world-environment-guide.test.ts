/** World Context Source 薄转发端口：前缀命名、激活生命周期、停用即摘除、不写历史。 */
import { expect, test } from "vitest";
import type { ContextSource } from "../src/core/types.js";
import { ExtensionHost } from "../src/extensions/host.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";

const GUIDE_A = "世界甲：环境认知甲";
const GUIDE_B = "世界乙：环境认知乙";

interface Registered {
	readonly owner: string;
	readonly source: ContextSource;
	readonly isActive: () => boolean;
}

/** pi 最小桩：只实现 WorldActivation 用到的端口；provideContext 透传给宿主。 */
function makeHost() {
	const host = new ExtensionHost();
	const registered: Registered[] = [];
	const pi = {
		subject: undefined,
		cwd: process.cwd(),
		isBusy: () => false,
		registerTool: () => () => {},
		on: () => () => {},
		provideContext: (source: ContextSource): (() => void) => {
			// owner 注入是 ExtensionRunner 的职责；这里用宿主同款注册（owner=桩身份），
			// World 转发层的合同（前缀 + 生命周期）由注册列表断言。
			const entry: Registered = { owner: "stub:framework", source, isActive: () => true };
			registered.push(entry);
			return () => {
				const index = registered.indexOf(entry);
				if (index >= 0) registered.splice(index, 1);
			};
		},
	} as never;
	return { host, pi, registered };
}

function activate(def: WorldDef, pi: never) {
	return new WorldActivation(def, {
		pi,
		runtime: { definition: def, enabled: true },
		worldName: def.name,
		notifyExposed() {},
	});
}

const definition = (name: string): WorldDef => ({
	name,
	description: `probe ${name}`,
	actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
	async onStart(ctx) {
		ctx.provideContext!({ id: "guidance", kind: "guidance", text: name === "mc" ? GUIDE_A : GUIDE_B });
	},
});

test("World 经薄转发端口注册 Context Source：框架加 world:<name>/ 前缀，停用即摘除", async () => {
	const { pi, registered } = makeHost();
	const activation = activate(definition("mc"), pi);
	await activation.start();
	try {
		expect(registered).toHaveLength(1);
		expect(registered[0]!.owner).toBe("stub:framework");
		expect(registered[0]!.source.id).toBe("world:mc/guidance");
		expect(registered[0]!.source.kind).toBe("guidance");
	} finally {
		await activation.stop();
	}
	// World 关闭时一并撤销所有 Source；下一次激活不得留下旧注册。
	expect(registered).toHaveLength(0);
});

test("多世界同名局部 ID 互不冲突；启动失败时注册随回滚撤下", async () => {
	const { pi, registered } = makeHost();
	const a = activate(definition("mc"), pi);
	const b = activate(definition("music"), pi);
	await a.start();
	await b.start();
	try {
		expect(registered.map((entry) => entry.source.id).sort()).toEqual(["world:mc/guidance", "world:music/guidance"]);
	} finally {
		await b.stop();
		await a.stop();
	}
	expect(registered).toHaveLength(0);

	// onStart 抛错：已注册的 Source 随启动回滚撤下。
	const failing: WorldDef = {
		...definition("broken"),
		async onStart(ctx) {
			ctx.provideContext!({ id: "guidance", kind: "guidance", text: "正文" });
			throw new Error("启动失败");
		},
	};
	const broken = activate(failing, pi);
	await expect(broken.start()).rejects.toThrow("启动失败");
	expect(registered).toHaveLength(0);
});

test("停用后注册明确失败；调用者不能重复前缀或伪造前缀", async () => {
	const { pi, registered } = makeHost();
	let captured: import("../src/extensions/world-framework/types.js").ServiceCompanionContext | undefined;
	const def: WorldDef = {
		...definition("mc"),
		async onStart(ctx) {
			captured = ctx;
			ctx.provideContext!({ id: "guidance", kind: "guidance", text: GUIDE_A });
		},
	};
	const activation = activate(def, pi);
	await activation.start();
	expect(registered).toHaveLength(1);

	await activation.stop();
	expect(registered).toHaveLength(0);
	// 停用后经同一端口注册：明确失败，不留半个 Source。
	expect(() => captured!.provideContext!({ id: "guidance", kind: "guidance", text: "迟到的正文" })).toThrow(
		/世界已停用/,
	);
	expect(registered).toHaveLength(0);

	// 局部 id 不允许自带 "world:" 前缀（Framework 自动添加，防止重复前缀）。
	const fake = activate(
		{
			...definition("fake"),
			async onStart(ctx) {
				ctx.provideContext!({ id: "world:fake/guidance", kind: "guidance", text: "正文" });
			},
		},
		pi,
	);
	await expect(fake.start()).rejects.toThrow(/不允许自带/);
	expect(registered).toHaveLength(0);
});
