/**
 * 具身状态变化落史（不唤醒）+ body status 按需查询——真对象接线测试。
 *
 * 与 embodiment-endpoint-wiring.test.ts 同一原则：真实 ExtensionRunner +
 * 真实 app-framework + 真实共享表 + 真实 embodiment 扩展 + 真实 BodyRouter，
 * 只有"身体端点"是探针。断言三条核心合同：
 * 1. 端点注册/注销（状态变化）→ appendCustomEntry 落史（embodiment.state-change）；
 * 2. 无状态变化（重复同步同一端点对象）→ 不落史；
 * 3. body status 返回单端点即时真值（缺省主导身体），未知 bodyId 报 failed。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { activateAppFramework, defineApp } from "../src/extensions/app-framework/index.js";
import { type AppDef } from "../src/extensions/app-framework/types.js";
import { IsolatedEnv } from "./harness/index.js";
import { BodyRouter } from "../.uina/extensions/embodiment/body-router.js";
import { projectEmbodimentContext } from "../.uina/extensions/embodiment/context-projector.js";
import type { BodyEndpoint } from "../.uina/extensions/embodiment/types.js";

/** appendCustomEntry 的入参形状（与 ExtensionAPI.appendCustomEntry 内联合同一致）。 */
interface StateChangeEntry {
	customType: string;
	data?: unknown;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hasLocalRuntime = existsSync(join(repoRoot, ".uina", "extensions", "embodiment", "index.ts"));
const BODY_ENDPOINT_EXPOSED_PREFIX = "body.endpoint:";

interface ProbeBodyEndpoint {
	readonly bodyId: string;
	readonly bodyType: string;
	affordance(): { bodyId: string; cues: readonly { id: string; description: string }[] };
	state(): { online: boolean };
	emitCue(cueId: string): void;
	safeStop(): Promise<void>;
}

function probeEndpoint(bodyId: string, online = true): ProbeBodyEndpoint {
	return {
		bodyId,
		bodyType: "avatar_2d",
		affordance: () => ({ bodyId, cues: [{ id: "warm_smile", description: "微笑" }] }),
		state: () => ({ online }),
		emitCue: () => {},
		safeStop: async () => {},
	};
}

let probeCtx: Parameters<NonNullable<AppDef["onStart"]>>[0] | undefined;

/** 探针应用：onStart 时经真实 ctx.expose 暴露端点，onStop 回收。返回端点句柄供测试内重暴露。 */
function createProbeApp(): { app: AppDef; getEndpoint: () => ProbeBodyEndpoint } {
	let endpoint: ProbeBodyEndpoint | undefined;
	let disposer: (() => void) | undefined;
	const app: AppDef = {
		name: "probe-body",
		description: "集成测试用探针应用",
		defaultState: { enabled: true, tier: "hidden" },
		actions: {},
		onStart(ctx) {
			probeCtx = ctx;
			endpoint = probeEndpoint("live2d_mo");
			disposer = ctx.expose?.(BODY_ENDPOINT_EXPOSED_PREFIX + endpoint.bodyId, endpoint);
		},
		onStop() {
			disposer?.();
			disposer = undefined;
			probeCtx = undefined;
		},
	};
	return { app, getEndpoint: () => endpoint! };
}

/** 可控替换端点状态的应用：每次 start 暴露 getOnline() 对应在线性的端点。 */
function createReplacerApp(getOnline: () => boolean): { app: AppDef } {
	let disposer: (() => void) | undefined;
	const app: AppDef = {
		name: "replace-body",
		description: "可替换端点的探针应用",
		defaultState: { enabled: true, tier: "hidden" },
		actions: {},
		onStart(ctx) {
			const ep = probeEndpoint("arm", getOnline());
			disposer = ctx.expose?.(BODY_ENDPOINT_EXPOSED_PREFIX + ep.bodyId, ep);
		},
		onStop() {
			disposer?.();
			disposer = undefined;
		},
	};
	return { app };
}

describe.skipIf(!hasLocalRuntime)("具身状态变化落史（不唤醒）与 body status 查询", () => {
	let env: IsolatedEnv;
	let entries: StateChangeEntry[];

	beforeEach(async () => {
		env = await IsolatedEnv.create({ prefix: "embodiment-state-journal-" });
		entries = [];
		probeCtx = undefined;
	});

	afterEach(async () => {
		await env.dispose();
	});

	async function setupRunner(app: AppDef): Promise<{ runner: ExtensionRunner; tools: ToolBroker }> {
		const tools = new ToolBroker();
		const runner = new ExtensionRunner({
			cwd: env.path,
			tools,
			onCustomEntry: async (entry) => {
				entries.push(structuredClone(entry));
			},
		});
		// 顺序与宿主一致：app-framework（含应用注册）先于项目扩展。
		await runner.activateBuiltin("app-framework", async (pi) => {
			const teardown = await activateAppFramework(pi);
			await defineApp(pi, app);
			return teardown;
		});
		const embodiment = await import("../.uina/extensions/embodiment/index.js");
		await runner.activateBuiltin("embodiment", (pi) => embodiment.activateEmbodimentExtension(pi).dispose);
		return { runner, tools };
	}

	it("端点注册落史一条 state-change，重复同步不重复落史", async () => {
		const { app, getEndpoint } = createProbeApp();
		await setupRunner(app);
		await flush();
		const changes = () => entries.filter((e) => e.customType === "embodiment.state-change");
		expect(changes()).toHaveLength(1);

		// 重新暴露同一端点对象（同名覆盖 → 订阅通知 → 同步运行）：摘要不变 → 不落史。
		// 局限：若共享表对同名重暴露是静默 no-op，sync 根本不跑，此断言空转——
		// 黑盒下无更优探针（订阅 listener 不可从外触发），接受该空洞通过风险并明示。
		probeCtx?.expose?.(BODY_ENDPOINT_EXPOSED_PREFIX + "live2d_mo", getEndpoint());
		await flush();
		expect(changes()).toHaveLength(1);
	});

	it("body status 返回即时真值，缺省主导身体", async () => {
		const { app } = createProbeApp();
		const { tools } = await setupRunner(app);
		await flush();

		const result = await tools.execute(tools.prepare("body", { action: "status" }));
		expect(result.status).toBe("succeeded");
		const parsed = JSON.parse(result.result) as Record<string, unknown>;
		expect(parsed.bodyId).toBe("live2d_mo");
		expect(parsed.online).toBe(true);
		expect(parsed.isFocal).toBe(true);
		expect(parsed.isPaused).toBe(false);
		expect(parsed.cues).toEqual(["warm_smile"]);
	});

	it("body status 查询未知端点报 failed；端点替换（注销+注册）落史", async () => {
		let replacerOnline = true;
		const { tools } = await setupRunner(createReplacerApp(() => replacerOnline).app);
		await flush();

		const missing = await tools.execute(tools.prepare("body", { action: "status", target: "nope" }));
		expect(missing.status).toBe("failed");

		replacerOnline = false;
		// 真实停用/启用路径：激活时已注册在线端点（落史1条）；disable 回收暴露项 → 注销（落史2条）；
		// enable 重新 onStart → 注册离线端点（落史3条）。共 ≥2 条新增。
		await waitFor(() => entries.filter((e) => e.customType === "embodiment.state-change").length >= 1);
		const before = entries.filter((e) => e.customType === "embodiment.state-change").length;
		await tools.execute(tools.prepare("app_store", { action: "disable", params: { name: "replace-body" } }));
		await tools.execute(tools.prepare("app_store", { action: "enable", params: { name: "replace-body" } }));
		await waitFor(() => entries.filter((e) => e.customType === "embodiment.state-change").length >= before + 2);
		const changes = entries.filter((e) => e.customType === "embodiment.state-change");
		const last = JSON.stringify(changes[changes.length - 1]);
	expect(last).toContain('"online":false');
	});
});

describe("具身投影器 projectEmbodimentContext（三态合同）", () => {
	function wireEndpoint(bodyId: string, online: boolean, fault?: string): BodyEndpoint {
		return {
			bodyId,
			bodyType: "avatar_2d",
			affordance: () => ({ bodyId, bodyType: "avatar_2d", cues: [{ id: "warm_smile", description: "微笑" }], description: "探针" }),
			state: () => ({ online, fault }),
			emitCue: () => {},
			safeStop: async () => {},
			onFocus: () => {},
		};
	}

	it("在线：状态行 + cue 列表（行为必需，保留）", () => {
		const router = new BodyRouter();
		router.registerEndpoint(wireEndpoint("live2d_mo", true));
		const text = projectEmbodimentContext(router)!;
		expect(text).toContain("[body] live2d_mo: 在线");
		expect(text).toContain("<cue id=\"warm_smile\"/>");
		expect(text).not.toContain("注意");
	});

	it("离线：单行状态 + fault；行为规范句不再逐轮复读", () => {
		const router = new BodyRouter();
		router.registerEndpoint(wireEndpoint("live2d_mo", false, "disconnected"));
		const text = projectEmbodimentContext(router)!;
		expect(text).toBe("[body] live2d_mo: 离线 (disconnected)");
		expect(text).not.toContain("若被问及");
	});

	it("无端点：undefined（0 帧 0 token）", () => {
		expect(projectEmbodimentContext(new BodyRouter())).toBeUndefined();
	});
});

async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** 轮询等待条件成立（跨真实异步边界，不猜微任务数）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 10));
	}
}
