import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { activateAppFramework, defineApp } from "../src/extensions/app-framework/index.js";
import {
	APP_EXPOSED_SHARED_NAME,
	type AppDef,
	type AppExposedRegistry,
} from "../src/extensions/app-framework/types.js";
import { IsolatedEnv } from "./harness/index.js";

/**
 * 具身端点共享名前缀。
 *
 * 刻意写成字面量而不是从 `.uina/extensions/embodiment/types.ts` 引入：
 * 本文件要能在没有 `.uina/` 的全新 clone 上被正常收集，而这里断言的是**双方协定**
 * 的线格式，不是某个实现常量——实现侧改名前缀必须让本测试变红，这正是它该做的事。
 */
const BODY_ENDPOINT_EXPOSED_PREFIX = "body.endpoint:";

/** `BodyEndpoint` 的最小结构视图：同样只为让本文件自包含。 */
interface ProbeBodyEndpoint {
	readonly bodyId: string;
	readonly bodyType: string;
	affordance(): { bodyId: string; cues: readonly { id: string; description: string }[] };
	state(): { online: boolean };
	emitCue(cueId: string): void;
	safeStop(): Promise<void>;
	onFocus?(isFocused: boolean): void;
}

/**
 * 应用端点 ↔ 具身路由的**跨真实边界**接线测试。
 *
 * 这是本轮修复的核心回归网。此前的测试全部在边界内侧打桩（mock callService 接受
 * 真端点、把 mock 端点直接塞进真 router），所以四条断开的接缝能与 100 例绿灯并存。
 * 本文件刻意全程使用真实对象：
 *   真实 ExtensionRunner + 真实 app-framework + 真实 AppRegistry + 真实 ctx.expose
 *   + 真实同进程共享表 + 真实 embodiment 扩展 + 真实 BodyRouter + 真实 body 工具
 *   + 真实 <cue> 剥离器。
 * 只有"身体端点"是探针——它是被测对象本身，必须可控。
 *
 * 有意**不经** app-loader（jiti）装载探针应用：本文件测的是接线，不是发现，而
 * loader 路径已由 app-framework-loader.test.ts 覆盖。同时这也让本文件不依赖
 * jiti，从而在 vmThreads 池下同样可运行（jiti 在该池下不可用，是既有环境限制）。
 *
 * `.uina/` 是本地运行时目录、不入库：缺少它时整套跳过而不是失败，
 * 于是本文件可以安全入库，同时不破坏全新 clone。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const embodimentEntry = join(repoRoot, ".uina", "extensions", "embodiment", "index.ts");
const hasLocalRuntime = existsSync(embodimentEntry);

const PROBE_BODY_ID = "probe-body-id";
const BOGUS_SHARED_NAME = BODY_ENDPOINT_EXPOSED_PREFIX + "bogus";

/** 探针身体：在线、带两条 cue，记录收到的 cue 与急停次数。 */
function createProbeEndpoint(): ProbeBodyEndpoint & { cues: string[]; safeStops: number } {
	const endpoint = {
		bodyId: PROBE_BODY_ID,
		bodyType: "custom" as const,
		cues: [] as string[],
		safeStops: 0,
		affordance: () => ({
			bodyId: PROBE_BODY_ID,
			bodyType: "custom" as const,
			description: "集成测试用探针身体",
			cues: [
				{ id: "warm_smile", description: "微笑", aliases: ["smile"] },
				{ id: "curious_tilt", description: "歪头" },
			],
		}),
		state: () => ({ online: true }),
		emitCue(cueId: string) {
			endpoint.cues.push(cueId);
		},
		async safeStop() {
			endpoint.safeStops += 1;
		},
		onFocus() {},
	};
	return endpoint;
}

let probeEndpoint: ReturnType<typeof createProbeEndpoint> | undefined;
let probeExposeDisposer: (() => void) | undefined;
let probeHostEvents: string[] = [];

function createProbeApp(): AppDef {
	return {
		name: "probe-body",
		description: "集成测试用探针应用",
		defaultState: { enabled: true, tier: "hidden" },
		actions: {},
		onStart(ctx) {
			probeEndpoint = createProbeEndpoint();
			probeExposeDisposer = ctx.expose?.(BODY_ENDPOINT_EXPOSED_PREFIX + PROBE_BODY_ID, probeEndpoint);
			ctx.onHostEvent?.((event) => {
				probeHostEvents.push(event.type);
			});
		},
		// 真实应用会在 onStop 里回收自己暴露的活引用；探针照做，顺带覆盖该释放路径。
		onStop() {
			probeExposeDisposer?.();
			probeExposeDisposer = undefined;
		},
	};
}

/** 契约不符的探针：只有 bodyId，没有任何行为方法。默认停用，由用例按需启用。 */
function createBogusApp(): AppDef {
	return {
		name: "bogus-body",
		description: "契约不符的探针应用",
		defaultState: { enabled: false, tier: "hidden" },
		actions: {},
		onStart(ctx) {
			ctx.expose?.(BOGUS_SHARED_NAME, { bodyId: "bogus", bodyType: "custom" });
		},
	};
}

describe.skipIf(!hasLocalRuntime)("应用端点 ↔ 具身路由：跨真实边界接线", () => {
	let env: IsolatedEnv;
	let runner: ExtensionRunner;
	let tools: ToolBroker;
	let errors: string[];

	beforeEach(async () => {
		probeEndpoint = undefined;
		probeExposeDisposer = undefined;
		probeHostEvents = [];
		env = await IsolatedEnv.create({ prefix: "uina-wiring-" });
		tools = new ToolBroker();
		runner = new ExtensionRunner({ cwd: env.path, tools, onCustomEntry: async () => {} });
		errors = [];
		runner.onError((err) => errors.push(err.error));

		// 顺序刻意与宿主一致：app-framework（含应用注册）先于项目扩展。
		// 这正是原缺陷成因之一——应用在扩展之前 onStart，消费侧尚不存在。
		// 这里追加注册探针应用，保证与 app-framework 共用同一个 AppRegistry 实例。
		await runner.activateBuiltin("app-framework", async (pi) => {
			const teardown = await activateAppFramework(pi);
			await defineApp(pi, createProbeApp());
			await defineApp(pi, createBogusApp());
			return teardown;
		});

		const embodiment = await import("../.uina/extensions/embodiment/index.js");
		await runner.activateBuiltin("embodiment", (pi) => embodiment.activateEmbodimentExtension(pi).dispose);
	});

	afterEach(async () => {
		await runner.dispose();
		await env.cleanup();
		probeEndpoint = undefined;
		probeExposeDisposer = undefined;
		probeHostEvents = [];
	});

	it("把应用暴露的活端点当作活引用交付，而不是可克隆的数据快照", () => {
		const feed = runner.shared(APP_EXPOSED_SHARED_NAME) as AppExposedRegistry | undefined;
		expect(feed).toBeDefined();

		const handle = feed!.get(BODY_ENDPOINT_EXPOSED_PREFIX + PROBE_BODY_ID);
		// 活引用：原型方法必须仍可调用。若改回 callService（双向 structuredClone），
		// 这里要么取到丢掉方法的普通对象，要么在注册时就抛 DataCloneError。
		expect(handle).toBe(probeEndpoint);
		expect(typeof (handle as ProbeBodyEndpoint).emitCue).toBe("function");
		expect(typeof (handle as ProbeBodyEndpoint).safeStop).toBe("function");
		expect(typeof (handle as ProbeBodyEndpoint).affordance).toBe("function");
	});

	it("端点注册后 body 工具能列出真实身体（S1）", async () => {
		const result = await tools.execute(tools.prepare("body", { action: "list" }));

		expect(result.status).toBe("succeeded");
		expect(result.result).toContain(PROBE_BODY_ID);
		// 默认停用的应用不得出现：注册由应用暴露驱动，而不是无条件扫描
		expect(result.result).not.toContain("bogus");
	});

	it("tail transformContext 把 cue 词汇注入具身状态帧组（S2）", async () => {
		const messages = [
			{ role: "user" as const, content: "原文" },
		];
		const output = (await runner.runtimeHooks().turn.transformContext({ projectionId: "test", modelKey: "test", messages, tools: [] })).messages;

		// systemPrompt 路径已废弃：prepare 不再追加具身文本（无其它 prepare 注入者时保持原样/undefined）
		const prepared = await runner.runtimeHooks().turn.prepare({ prompt: "", systemPrompt: "BASE" });
		expect(prepared?.systemPrompt).toContain("[具身规范]");

		// 尾部帧组：三消息原子组，回执含主导身体与 cue 词汇
		expect(output.length).toBe(messages.length + 3);
		const tail = output.slice(messages.length);
		expect(tail.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
		expect(tail[0]!.content).toContain("具身状态感知");
		expect(tail[0]!.content).toContain("非用户输入");
		expect(tail[2]!.content).toContain(PROBE_BODY_ID);
		expect(tail[2]!.content).toContain("warm_smile");
		expect(tail[2]!.content).toContain("curious_tilt");

		// 协议校验：帧组结构合法
		const profile = await import("../src/extensions/event-frames/index.js");
		expect(() => profile.createEventFrameProfile().projection.validateContext!(tail as never)).not.toThrow();
	});

	it("输出流里的 <cue> 真正抵达端点，含跨分块被截断的标签（S3）", async () => {
		await runner.emit({
			type: "output_update",
			streamId: "s1",
			offset: 0,
			channel: "content",
			text: '你好<cue id="warm_smile"/>，今天天气',
		});
		await runner.emit({
			type: "output_update",
			streamId: "s1",
			offset: 1,
			channel: "content",
			text: '不错<cue id="curious',
		});
		await runner.emit({
			type: "output_update",
			streamId: "s1",
			offset: 2,
			channel: "content",
			text: '_tilt"/>。',
		});

		expect(probeEndpoint!.cues).toEqual(["warm_smile", "curious_tilt"]);
	});

	it("thinking 通道的 cue 不派发（通道过滤）", async () => {
		await runner.emit({
			type: "output_update",
			streamId: "s2",
			offset: 0,
			channel: "thinking",
			text: '<cue id="warm_smile"/>',
		});

		expect(probeEndpoint!.cues).toEqual([]);
	});

	it("别名属于声明的响应集合：别名 cue 也能送达，且传原始 cueId（S3 补充）", async () => {
		await runner.emit({
			type: "output_update",
			streamId: "s5",
			offset: 0,
			channel: "content",
			text: '<cue id="smile"/>',
		});

		// 传给端点的是**原始 cueId**——别名→规范 id 的归一化由端点自己负责（宿主不解释语义）
		expect(probeEndpoint!.cues).toEqual(["smile"]);
	});

	it("未被任何身体响应的线索必须可见，且同一未知线索只报一次", async () => {
		for (let i = 0; i < 2; i++) {
			await runner.emit({
				type: "output_update",
				streamId: "s6",
				offset: i,
				channel: "content",
				text: '<cue id="nope"/>',
			});
		}

		const reports = errors.filter((e) => e.includes('"nope"'));
		expect(reports.length).toBe(1);
		// 报错必须列出可用 cue id，让「为什么没反应」可以直接判定
		expect(reports[0]).toContain("warm_smile");
		expect(reports[0]).toContain("未能送达任何身体");
	});

	it("身体管理动作对真实端点生效，且暂停期间屏蔽 cue（S8）", async () => {
		const paused = await tools.execute(tools.prepare("body", { action: "pause", target: PROBE_BODY_ID }));
		expect(paused.status).toBe("succeeded");
		// pause 必须真正调用端点 safeStop，而不是只改路由表
		expect(probeEndpoint!.safeStops).toBe(1);

		await runner.emit({
			type: "output_update",
			streamId: "s3",
			offset: 0,
			channel: "content",
			text: '<cue id="warm_smile"/>',
		});
		expect(probeEndpoint!.cues).toEqual([]);

		const resumed = await tools.execute(tools.prepare("body", { action: "resume", target: PROBE_BODY_ID }));
		expect(resumed.status).toBe("succeeded");

		await runner.emit({
			type: "output_update",
			streamId: "s3",
			offset: 1,
			channel: "content",
			text: '<cue id="warm_smile"/>',
		});
		expect(probeEndpoint!.cues).toEqual(["warm_smile"]);
	});

	it("应用停用后活引用与路由登记一并回收，不留悬垂", async () => {
		const feed = runner.shared(APP_EXPOSED_SHARED_NAME) as AppExposedRegistry;
		expect(feed.names()).toContain(BODY_ENDPOINT_EXPOSED_PREFIX + PROBE_BODY_ID);

		const disabled = await tools.execute(
			tools.prepare("app_store", { action: "disable", params: { name: "probe-body" } }),
		);
		expect(disabled.status).toBe("succeeded");
		// 应用侧自己回收了暴露项（onStop 调用 expose 返回的释放器），
		// 与框架侧的 clearExposedFor 构成两条幂等回收路径
		expect(probeExposeDisposer).toBeUndefined();

		expect(feed.names()).not.toContain(BODY_ENDPOINT_EXPOSED_PREFIX + PROBE_BODY_ID);
		const listed = await tools.execute(tools.prepare("body", { action: "list" }));
		expect(listed.result).not.toContain(PROBE_BODY_ID);

		// 宿主订阅同样必须随停用回收：停用的应用不得继续收到宿主事件
		expect(probeHostEvents).toEqual([]);
		await runner.emit({ type: "turn_start", turnNumber: 2, userText: "after-disable" });
		expect(probeHostEvents).toEqual([]);
	});

	it("应用启用的同时订阅宿主事件，停用后被框架强制回收（订阅生命周期）", async () => {
		await runner.emit({ type: "turn_start", turnNumber: 1, userText: "hi" });
		expect(probeHostEvents).toEqual(["turn_start"]);

		await tools.execute(tools.prepare("app_store", { action: "disable", params: { name: "probe-body" } }));
		probeHostEvents = [];
		await runner.emit({ type: "turn_start", turnNumber: 2, userText: "after-disable" });
		// 框架记账回收即可，不依赖应用自觉退订
		expect(probeHostEvents).toEqual([]);
	});

	it("契约不符的共享值被拒绝注册并上报错误，不污染路由表", async () => {
		const enabled = await tools.execute(
			tools.prepare("app_store", { action: "enable", params: { name: "bogus-body" } }),
		);
		expect(enabled.status).toBe("succeeded");

		expect(errors.some((e) => e.includes(BOGUS_SHARED_NAME))).toBe(true);
		const listed = await tools.execute(tools.prepare("body", { action: "list" }));
		expect(listed.result).not.toContain("bogus");
	});
});
