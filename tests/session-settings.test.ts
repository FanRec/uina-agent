/**
 * 会话偏好持久化（~/.uina/settings.json），走真实链路：
 * UINA_HOME 指向临时目录，auth.json 提供 provider/模型（loadConfig → ModelRegistry），
 * 运行时切换模型/思考度 → 写盘；新 host（= 重启）→ 恢复；失效 → 静默降级。
 * 优先级：CLI -m 显式指定 > settings.json > auth.json 默认。
 *
 * 基于 Uina Test Kit 治理，统一 RAII 临时沙箱管理。
 */
import { describe, expect, test, afterEach } from "./harness/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSettings } from "../src/ai/settings.js";
import { IsolatedEnv } from "./harness/environment/isolated-env.js";
import { UinaTestHarness } from "./harness/host/harness.js";

const AUTH = {
	default: "alpha",
	providers: {
		alpha: { type: "openai-compatible", baseUrl: "http://localhost:1", model: "model-alpha", apiKey: "k", modelContextWindow: 4096, thinkingLevels: ["off", "low", "high"] },
		beta: { type: "openai-compatible", baseUrl: "http://localhost:1", model: "model-beta", apiKey: "k", modelContextWindow: 4096, thinkingLevels: ["off", "low"] },
	},
} as const;

/** 轮询等待 fire-and-forget 的偏好落盘完成（写失败不打断回合，故只等不抛）。 */
async function waitFor(pred: () => Promise<boolean>, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`等待超时: ${what}`);
}

describe("会话偏好持久化", () => {
	const disposables: Array<{ dispose: () => Promise<void> }> = [];
	let savedHome: string | undefined;

	afterEach(async () => {
		process.env.UINA_HOME = savedHome;
		for (const item of disposables.splice(0)) await item.dispose().catch(() => undefined);
	});

	async function useTempHome(auth: unknown = AUTH): Promise<IsolatedEnv> {
		savedHome = process.env.UINA_HOME;
		const homeEnv = await IsolatedEnv.create({ prefix: "uina-settings-" });
		disposables.push(homeEnv);
		process.env.UINA_HOME = homeEnv.cwd;
		await homeEnv.writeFile(join(".uina", "auth.json"), JSON.stringify(auth));
		return homeEnv;
	}

	function settingsFile(homeEnv: IsolatedEnv): string {
		return join(homeEnv.cwd, ".uina", "settings.json");
	}

	async function makeHarness(options: { modelName?: string } = {}): Promise<UinaTestHarness> {
		const env = await IsolatedEnv.create({ prefix: "uina-host-" });
		disposables.push(env);
		const harness = await UinaTestHarness.create({
			env,
			useConfig: true,
			hostOptions: {
				modelName: options.modelName,
				stream: async (_m, _r, onDelta) => {
					onDelta({ kind: "text", text: "ok" });
					onDelta({ kind: "finish", reason: "stop" });
				},
			},
		});
		return harness;
	}

	test("运行时切换模型写盘；重启后恢复该模型", async () => {
		await useTempHome();
		const first = await makeHarness();
		expect(first.host.snapshot().modelName).toBe("model-alpha"); // auth.json default
		await first.host.subject.setModel(first.host.models.resolve("model-beta"));
		await waitFor(async () => (await loadSettings()).model === "beta/model-beta", "写盘 beta/model-beta");

		// "重启"：新 host、无 CLI 指定 → 从 settings 恢复 model-beta（并落在同一个 provider 上）
		const second = await makeHarness();
		expect(second.host.snapshot().modelName).toBe("model-beta");
		expect(second.host.subject.getModel().providerId).toBe("beta");
	});

	test("CLI -m 显式指定赢过 settings.json；陈旧模型名不炸启动", async () => {
		const home = await useTempHome();
		await home.writeFile(join(".uina", "settings.json"), JSON.stringify({ model: "ghost-model", thinkingLevel: "high" }));
		const harness = await makeHarness({ modelName: "model-alpha" });
		expect(harness.host.snapshot().modelName).toBe("model-alpha"); // -m 赢；ghost-model 未解析也不炸
	});

	test("settings.json 里的失效模型静默落回 auth.json 默认", async () => {
		const home = await useTempHome();
		await home.writeFile(join(".uina", "settings.json"), JSON.stringify({ model: "long-gone", thinkingLevel: "high" }));
		const harness = await makeHarness();
		expect(harness.host.snapshot().modelName).toBe("model-alpha"); // 默认模型，启动不炸
	});

	test("思考档位随模型恢复；跨模型恢复时不受支持则丢弃", async () => {
		const home = await useTempHome();
		const first = await makeHarness();
		await first.host.subject.setModel(first.host.models.resolve("model-beta"));
		await first.host.subject.setThinkingLevel("low");
		await waitFor(async () => (await loadSettings()).thinkingLevel === "low", "写盘 low");

		// 重启：恢复 model-beta + low
		const second = await makeHarness();
		expect(second.host.snapshot().modelName).toBe("model-beta");
		expect(second.host.snapshot().thinkingLevel).toBe("low");

		// 再重启但 settings 指向不支持该档位的组合：档位丢弃、模型照常
		await home.writeFile(join(".uina", "settings.json"), JSON.stringify({ model: "model-beta", thinkingLevel: "xhigh" }));
		const third = await makeHarness();
		expect(third.host.snapshot().modelName).toBe("model-beta");
		expect(third.host.snapshot().thinkingLevel).toBe("off"); // mock 默认首个档位
	});

	test("settings.json 损坏时按空对象处理，启动不炸", async () => {
		const home = await useTempHome();
		await home.writeFile(join(".uina", "settings.json"), "{not json");
		const harness = await makeHarness();
		expect(harness.host.snapshot().modelName).toBe("model-alpha");
	});

	test("原子写：写盘后文件是合法 JSON 且含预期字段", async () => {
		const home = await useTempHome();
		const harness = await makeHarness();
		await harness.host.subject.setModel(harness.host.models.resolve("model-beta"));
		await waitFor(async () => (await loadSettings()).model === "beta/model-beta", "写盘 beta/model-beta");
		const raw = await readFile(settingsFile(home), "utf8");
		const parsed = JSON.parse(raw) as { model?: string; thinkingLevel?: string };
		expect(parsed.model).toBe("beta/model-beta");
		expect(Object.keys(parsed).sort()).toEqual(["model", "thinkingLevel"]);
	});

	test("[跨 provider 同名模型] 写盘带 provider 身份，重启还原到同一 provider", async () => {
		// 两个 provider 暴露同一个模型 id：只按裸 id 存盘会还原成先注册的 alpha
		const HOME = {
			default: "alpha",
			providers: {
				alpha: { type: "openai-compatible", baseUrl: "http://localhost:1", model: "shared-model", apiKey: "k", modelContextWindow: 4096, thinkingLevels: ["off", "low", "high"] },
				beta: { type: "openai-compatible", baseUrl: "http://localhost:1", model: "shared-model", apiKey: "k", modelContextWindow: 8192, thinkingLevels: ["off", "low"] },
			},
		};
		await useTempHome(HOME);
		const first = await makeHarness();
		expect(first.host.subject.getModel().providerId).toBe("alpha"); // auth.json 默认（先注册者）
		await first.host.subject.setModel(first.host.models.resolve("beta/shared-model"));
		await waitFor(async () => (await loadSettings()).model === "beta/shared-model", "写盘身份键");

		const second = await makeHarness(); // 重启
		expect(second.host.subject.getModel().providerId).toBe("beta");
		expect(second.host.subject.getModel().id).toBe("shared-model");
		// 两个 provider 的 contextWindow 不同：用它能反证恢复的确实是 beta 那一个
		expect(second.host.subject.getModel().contextWindow).toBe(8192);
	});
});
