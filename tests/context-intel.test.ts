/**
 * 上下文检视数据链路测试：Context Source 注册（扩展作用域）→ AssemblyTrace
 * （Composer）→ inspectRequest（Subject 只读预览）。三层各自钉住契约，防止
 * "注册/装配/检视"任意一环静默断链。
 */

import { afterEach, describe, expect, it } from "vitest";
import { type ExtensionAPI, ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { SubjectHarness } from "./harness/core/subject-harness.js";
import { IsolatedEnv } from "./harness/index.js";

const envs: IsolatedEnv[] = [];
const runners: ExtensionRunner[] = [];

afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});

async function temp(): Promise<string> {
	const env = await IsolatedEnv.create();
	envs.push(env);
	return env.path;
}

function runner(cwd: string): ExtensionRunner {
	const value = new ExtensionRunner({ cwd, tools: new ToolBroker({ ownerId: "root" }) });
	runners.push(value);
	return value;
}

async function activate(host: ExtensionRunner, id: string, fn: (api: ExtensionAPI) => void): Promise<void> {
	await host.activateBuiltin(id, fn);
}

describe("extension runner source registry", () => {
	it("collects registered Context Sources with real activation identity as owner", async () => {
		const host = runner(await temp());
		await activate(host, "a", (api) => {
			api.provideContext({ id: "g", kind: "guidance", text: "稳定指南" });
		});
		await activate(host, "b", (api) => {
			api.provideContext({
				id: "cap",
				kind: "capability",
				read: () => ({ text: "能力正文", source: { type: "probe", origin: "internal" } }),
			});
		});

		const collection = await host.runCollectContext({ modelKey: "mock/mock", signal: new AbortController().signal });
		const byId = new Map(collection.contributions.map((c) => [c.key, c]));
		// owner 强制为激活作用域身份，Source 不能自报或伪造。
		expect(byId.get("builtin:a::g")?.owner).toBe("builtin:a");
		expect(byId.get("builtin:a::g")?.kind).toBe("guidance");
		expect(byId.get("builtin:b::cap")?.owner).toBe("builtin:b");
		expect(byId.get("builtin:b::cap")?.value).toMatchObject({ text: "能力正文" });
	});

	it("collect returns fresh snapshots per call without cross-call accumulation", async () => {
		const host = runner(await temp());
		let active = true;
		host.provideContext("builtin:a", { id: "g", kind: "guidance", text: "指南" }, () => active);
		const first = await host.runCollectContext({ modelKey: "m", signal: new AbortController().signal });
		expect(first.contributions).toHaveLength(1);

		// Source 失活（扩展卸载窗口）：collect 不再贡献，并把注销事实如实带出。
		active = false;
		const second = await host.runCollectContext({ modelKey: "m", signal: new AbortController().signal });
		expect(second.contributions).toHaveLength(0);
		expect(second.omitted.some((entry) => entry.status === "unregistered" && entry.id === "g")).toBe(true);
	});
});

describe("inspectRequest assembly trace", () => {
	it("exposes per-Source contribution facts (owner/id/kind/messageIndex) for the preview", async () => {
		const host = runner(await temp());
		await activate(host, "a", (api) => {
			api.provideContext({ id: "g", kind: "guidance", text: "指南正文" });
		});
		await activate(host, "b", (api) => {
			api.provideContext({
				id: "obs",
				kind: "observation",
				read: () => ({ text: "观察正文", source: { type: "probe", origin: "internal" } }),
			});
		});
		const harness = SubjectHarness.create({
			runtimeHooks: host.runtimeHooks(),
			broker: host["options"].tools,
		});

		const inspection = await harness.subject.inspectRequest();
		// preview 有独立身份，不冒充已发送
		expect(inspection.basis).toBe("preview");
		expect(inspection.requestId).toMatch(/^preview-/);
		const sources = inspection.assembly?.sources ?? [];
		const guidance = sources.find((s) => s.id === "g");
		const observation = sources.find((s) => s.id === "obs");
		expect(guidance).toMatchObject({ owner: "builtin:a", kind: "guidance", status: "included" });
		expect(typeof guidance?.messageIndex).toBe("number");
		expect(guidance?.charOffset).toBeGreaterThan(0);
		expect(observation).toMatchObject({ owner: "builtin:b", kind: "observation", status: "included" });
		// guidance 在 System 之后的固定前缀；observation 在历史之后
		const messages = inspection.projection.messages;
		expect(messages[0]?.role).toBe("system");
		expect(messages[guidance!.messageIndex!]?.context?.kind).toBe("runtime.guidance");
	});

	it("omitted sources surface as unregistered facts, not silent absence", async () => {
		const host = runner(await temp());
		let active = true;
		host.provideContext("builtin:a", { id: "gone", kind: "guidance", text: "正文" }, () => active);
		active = false;
		const harness = SubjectHarness.create({ runtimeHooks: host.runtimeHooks(), broker: host["options"].tools });
		const inspection = await harness.subject.inspectRequest();
		expect(inspection.assembly?.sources.some((s) => s.id === "gone" && s.status === "unregistered")).toBe(true);
	});
});
