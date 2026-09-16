import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UinaHost } from "../src/host/host.js";
import { loadSettings } from "../src/ai/settings.js";

/**
 * 会话偏好持久化（~/.uina/settings.json），走真实链路：
 * UINA_HOME 指向临时目录，auth.json 提供 provider/模型（loadConfig → ModelRegistry），
 * 运行时切换模型/思考度 → 写盘；新 host（= 重启）→ 恢复；失效 → 静默降级。
 * 优先级：CLI -m 显式指定 > settings.json > auth.json 默认。
 */

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
	const dirs: string[] = [];
	let savedHome: string | undefined;

	afterEach(async () => {
		process.env.UINA_HOME = savedHome;
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	async function useTempHome(auth: unknown = AUTH): Promise<string> {
		savedHome = process.env.UINA_HOME;
		const dir = await mkdtemp(join(tmpdir(), "uina-settings-"));
		dirs.push(dir);
		process.env.UINA_HOME = dir;
		await mkdir(join(dir, ".uina"), { recursive: true });
		await writeFile(join(dir, ".uina", "auth.json"), JSON.stringify(auth), "utf8");
		return dir;
	}

	function settingsFile(home: string): string {
		return join(home, ".uina", "settings.json");
	}

	async function makeHost(options: { modelName?: string } = {}): Promise<UinaHost> {
		const cwd = await mkdtemp(join(tmpdir(), "uina-host-"));
		dirs.push(cwd);
		const host = await UinaHost.create({
			cwd,
			modelName: options.modelName,
			stream: async (_m, _r, onDelta) => { onDelta({ kind: "text", text: "ok" }); onDelta({ kind: "finish", reason: "stop" }); },
		});
		await host.start();
		return host;
	}

	it("运行时切换模型写盘；重启后恢复该模型", async () => {
		const home = await useTempHome();
		const first = await makeHost();
		expect(first.snapshot().modelName).toBe("model-alpha"); // auth.json default
		await first.subject.setModel(first.models.resolve("model-beta"));
		await waitFor(async () => (await loadSettings()).model === "beta/model-beta", "写盘 beta/model-beta");

		// "重启"：新 host、无 CLI 指定 → 从 settings 恢复 model-beta（并落在同一个 provider 上）
		const second = await makeHost();
		expect(second.snapshot().modelName).toBe("model-beta");
		expect(second.subject.getModel().providerId).toBe("beta");
		void home;
	});

	it("CLI -m 显式指定赢过 settings.json；陈旧模型名不炸启动", async () => {
		const home = await useTempHome();
		await writeFile(settingsFile(home), JSON.stringify({ model: "ghost-model", thinkingLevel: "high" }), "utf8");
		const host = await makeHost({ modelName: "model-alpha" });
		expect(host.snapshot().modelName).toBe("model-alpha"); // -m 赢；ghost-model 未解析也不炸
	});

	it("settings.json 里的失效模型静默落回 auth.json 默认", async () => {
		const home = await useTempHome();
		await writeFile(settingsFile(home), JSON.stringify({ model: "long-gone", thinkingLevel: "high" }), "utf8");
		const host = await makeHost();
		expect(host.snapshot().modelName).toBe("model-alpha"); // 默认模型，启动不炸
	});

	it("思考档位随模型恢复；跨模型恢复时不受支持则丢弃", async () => {
		const home = await useTempHome();
		const first = await makeHost();
		await first.subject.setModel(first.models.resolve("model-beta"));
		await first.subject.setThinkingLevel("low");
		await waitFor(async () => (await loadSettings()).thinkingLevel === "low", "写盘 low");

		// 重启：恢复 model-beta + low
		const second = await makeHost();
		expect(second.snapshot().modelName).toBe("model-beta");
		expect(second.snapshot().thinkingLevel).toBe("low");

		// 再重启但 settings 指向不支持该档位的组合：档位丢弃、模型照常
		await writeFile(settingsFile(home), JSON.stringify({ model: "model-beta", thinkingLevel: "xhigh" }), "utf8");
		const third = await makeHost();
		expect(third.snapshot().modelName).toBe("model-beta");
		expect(third.snapshot().thinkingLevel).toBe("off"); // mock 默认首个档位
	});

	it("settings.json 损坏时按空对象处理，启动不炸", async () => {
		const home = await useTempHome();
		await writeFile(settingsFile(home), "{not json", "utf8");
		const host = await makeHost();
		expect(host.snapshot().modelName).toBe("model-alpha");
	});

	it("原子写：写盘后文件是合法 JSON 且含预期字段", async () => {
		const home = await useTempHome();
		const host = await makeHost();
		await host.subject.setModel(host.models.resolve("model-beta"));
		await waitFor(async () => (await loadSettings()).model === "beta/model-beta", "写盘 beta/model-beta");
		const raw = await readFile(settingsFile(home), "utf8");
		const parsed = JSON.parse(raw) as { model?: string; thinkingLevel?: string };
		expect(parsed.model).toBe("beta/model-beta");
		expect(Object.keys(parsed).sort()).toEqual(["model", "thinkingLevel"]);
	});

	it("[跨 provider 同名模型] 写盘带 provider 身份，重启还原到同一 provider", async () => {
		// 两个 provider 暴露同一个模型 id：只按裸 id 存盘会还原成先注册的 alpha
		const HOME = {
			default: "alpha",
			providers: {
				alpha: { type: "openai-compatible", baseUrl: "http://localhost:1", model: "shared-model", apiKey: "k", modelContextWindow: 4096, thinkingLevels: ["off", "low", "high"] },
				beta: { type: "openai-compatible", baseUrl: "http://localhost:1", model: "shared-model", apiKey: "k", modelContextWindow: 8192, thinkingLevels: ["off", "low"] },
			},
		};
		await useTempHome(HOME);
		const first = await makeHost();
		expect(first.subject.getModel().providerId).toBe("alpha"); // auth.json 默认（先注册者）
		await first.subject.setModel(first.models.resolve("beta/shared-model"));
		await waitFor(async () => (await loadSettings()).model === "beta/shared-model", "写盘身份键");

		const second = await makeHost(); // 重启
		expect(second.subject.getModel().providerId).toBe("beta");
		expect(second.subject.getModel().id).toBe("shared-model");
		// 两个 provider 的 contextWindow 不同：用它能反证恢复的确实是 beta 那一个
		expect(second.subject.getModel().contextWindow).toBe(8192);
	});

	it("[兼容] 旧格式裸模型名按注册顺序还原；provider 改名/下线时回落到同名模型", async () => {
		const home = await useTempHome();
		// 旧格式（裸名）：仍能还原（落到该 id 的默认 provider alpha）
		await writeFile(settingsFile(home), JSON.stringify({ model: "model-beta" }), "utf8");
		const legacy = await makeHost();
		expect(legacy.subject.getModel().id).toBe("model-beta");

		// 身份键里的 provider 已不存在（改名/下线）：回落到同名模型，不炸启动
		await writeFile(settingsFile(home), JSON.stringify({ model: "ghost/model-beta" }), "utf8");
		const renamed = await makeHost();
		expect(renamed.subject.getModel().id).toBe("model-beta");
	});
});
