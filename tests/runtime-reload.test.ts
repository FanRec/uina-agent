/**
 * 资源刷新与扩展换代（S2/S3）验收测试：
 *
 * - A4：Agent 修改 System/文件式 Guidance → runtime_reload(resources) 成功返回
 *   phase=applied → 下一次真实 Provider 请求必须使用新版本；扩展实例与 Session 保持。
 * - A5：文件 Guidance 编译致命错误时资源全部保持上一发布版本；重复成功 Reload
 *   不推进 revision、不产生虚假变更。
 * - A6：Reload/请求并发时不产生混合 System/Guidance 版本（装配期间版本换代即重装）。
 * - A7：runtime_reload(extensions) 返回 scheduled + reloadId + continuation=stop，
 *   不可假报 applied；不出现 tool-await-idle 死锁。
 * - A8：换代在回合结算后、自动续队之前实施；不丢排队输入、不重排；完成报告以
 *   内部 runtime Input 恰好交付一次并越过自身输入门。
 */

import { afterEach, describe, expect, it } from "vitest";
import { IsolatedEnv } from "./harness/environment/isolated-env.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { Scenario } from "./harness/provider/scenario.js";

const FILE_GUIDANCE_EXTENSION = `export default function activate(pi) {
	pi.provideContext({ id: "note", kind: "guidance", file: "prompts/note.md" });
}`;

// 第 1 次读取发生在启动基线检视（此时文件仍是 V1）；第 2 次读取发生在真实请求
// 装配的 collect 期间——在那一刻触发 reload，模拟"装配期间资源换代"。
const RACE_EXTENSION = `let count = 0;
let probe = "not-run";
export default function activate(pi) {
	pi.provideContext({
		id: "race",
		kind: "observation",
		read: async () => {
			count++;
			if (count === 2) {
				try {
					const outcome = await pi.reloadResources();
					probe = "OUTCOME:" + JSON.stringify(outcome);
				} catch (error) {
					probe = "ERR:" + String(error);
				}
			}
			return { text: "race-observation " + probe, source: { type: "race.probe", origin: "internal" } };
		},
	});
}`;

const harnesses: UinaTestHarness[] = [];
const envs: IsolatedEnv[] = [];

/** 创建隔离环境并在宿主创建前写入资源文件（System/Guidance 的选择发生在 create）。 */
/** 轮询等待换代完成报告进入会话历史（完成报告入队 → 队列恢复 → 报告回合可能尚未结束）。 */
async function waitForCompletionReport(harness: UinaTestHarness, reloadId: string | undefined): Promise<string> {
	for (let i = 0; i < 150; i++) {
		const contents = harness.history.map((m) => String((m as { content?: string }).content ?? ""));
		const report = contents.find((text) => text.includes("扩展换代已完成"));
		if (report !== undefined && (reloadId === undefined || report.includes(reloadId.slice(0, 8)))) return report;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("扩展换代完成报告未在预期时间内出现");
}

async function createHarness(
	setup?: (env: IsolatedEnv) => Promise<void>,
	options?: { scenario?: Scenario; autoStart?: boolean },
): Promise<UinaTestHarness> {
	const env = await IsolatedEnv.create();
	await setup?.(env);
	const harness = await UinaTestHarness.create({
		env,
		scenario: options?.scenario,
		autoStart: options?.autoStart ?? false,
		useConfig: false,
	});
	harnesses.push(harness);
	envs.push(env);
	return harness;
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.dispose();
	for (const env of envs.splice(0)) await env.dispose();
});

describe("runtime_reload(resources)：准备—发布—响应合同", () => {
	it("文件式 Guidance 与 System 文件变更后，下一次真实请求使用新版本（A4）", async () => {
		const harness = await createHarness(async (env) => {
			await env.writeExtension("note-ext/index.mjs", FILE_GUIDANCE_EXTENSION);
			await env.writeFile(".uina/extensions/note-ext/prompts/note.md", "GUIDANCE-V1");
			await env.writeFile(".uina/system.md", "# 系统 V1");
		});
		await harness.start();
		await harness.send("ping");

		// 第一次请求：旧 System 与旧 Guidance。
		const first = harness.scenario.calls[0]!;
		expect(String(first.messages.find((m) => m.role === "system")?.content)).toContain("# 系统 V1");
		expect(JSON.stringify(first.messages)).toContain("GUIDANCE-V1");

		// Agent 修改资源文件 → runtime_reload(resources)。
		await harness.env.writeFile(".uina/extensions/note-ext/prompts/note.md", "GUIDANCE-V2");
		await harness.env.writeFile(".uina/system.md", "# 系统 V2");
		const outcome = await harness.host.runToolDirect("runtime_reload", { scope: "resources" });
		expect(outcome.status).toBe("succeeded");
		expect((outcome.details as { phase?: string } | undefined)?.phase).toBe("applied");
		expect(typeof (outcome.details as { revision?: string } | undefined)?.revision).toBe("string");

		// 下一次请求必须使用新版本；扩展实例与 Session 保持（同一条会话继续追加）。
		await harness.send("again");
		const second = harness.scenario.calls[1]!;
		const systemText = String(second.messages.find((m) => m.role === "system")?.content);
		expect(systemText).toContain("# 系统 V2");
		expect(systemText).not.toContain("# 系统 V1");
		expect(JSON.stringify(second.messages)).toContain("GUIDANCE-V2");
		expect(JSON.stringify(second.messages)).not.toContain("GUIDANCE-V1");
		expect(harness.scenario.calls.length).toBe(2);
	});

	it("Guidance 编译致命错误：整体拒绝发布，资源保持上一版本（A5）", async () => {
		const harness = await createHarness(async (env) => {
			await env.writeExtension("note-ext/index.mjs", FILE_GUIDANCE_EXTENSION);
			await env.writeFile(".uina/extensions/note-ext/prompts/note.md", "GUIDANCE-V1");
		});
		await harness.start();
		await harness.send("ping");
		const revisionBefore = harness.host.getSystemSnapshot().revision;

		// 入口引用不存在的文件：编译失败 → 资源刷新失败且现行资源完全不变。
		await harness.env.writeFile(".uina/extensions/note-ext/prompts/note.md", "{{include:missing.md}}");
		const outcome = await harness.host.runToolDirect("runtime_reload", { scope: "resources" });
		expect(outcome.status).toBe("failed");
		expect((outcome.details as { phase?: string } | undefined)?.phase).toBe("unchanged");
		expect(String(outcome.result)).toContain("note.md");
		expect(harness.host.getSystemSnapshot().revision).toBe(revisionBefore);

		// 下一次请求仍使用旧版本。
		await harness.send("again");
		expect(JSON.stringify(harness.scenario.calls[1]!.messages)).toContain("GUIDANCE-V1");
	});

	it("连续成功 Reload 且内容无变化：不推进版本、返回 unchanged（A5）", async () => {
		const harness = await createHarness();
		await harness.start();
		const first = await harness.host.runToolDirect("runtime_reload", { scope: "resources" });
		expect(first.status).toBe("succeeded");
		const revision = (first.details as { revision?: string } | undefined)?.revision;
		expect(typeof revision).toBe("string");
		const second = await harness.host.runToolDirect("runtime_reload", { scope: "resources" });
		expect(second.status).toBe("succeeded");
		expect((second.details as { unchanged?: boolean } | undefined)?.unchanged).toBe(true);
		expect((second.details as { revision?: string } | undefined)?.revision).toBe(revision);
		expect(harness.host.getSystemSnapshot().revision).toBe(revision);
	});

	it("非法 scope 被校验拦截（not_started）；非法 System 文件在刷新时失败并保持旧版本（A5）", async () => {
		const harness = await createHarness(async (env) => {
			await env.writeFile(".uina/system.md", "# 系统 V1");
		});
		await harness.start();
		// schema 校验（enum）在启动前拦截：not_started，工具体未执行。
		const bad = await harness.host.runToolDirect("runtime_reload", { scope: "everything" });
		expect(bad.status).toBe("not_started");

		// 存在但非法 UTF-8 的 System 文件：刷新报错、保留旧版本，不静默退到内置默认。
		await harness.env.writeFile(".uina/system.md", new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
		const outcome = await harness.host.runToolDirect("runtime_reload", { scope: "resources" });
		expect(outcome.status).toBe("failed");
		expect(String(outcome.result)).toContain("system.md");
		expect(harness.host.getSystemSnapshot().source).toBe("workspace");
		expect(String(harness.host.getSystemSnapshot().text)).toContain("# 系统 V1");
	});
});

describe("runtime_reload(extensions)：受理排定与回合安全点", () => {
	it("空闲受理返回 scheduled + reloadId + continuation=stop，不假报 applied（A7）", async () => {
		const harness = await createHarness(undefined, { autoStart: true });
		const outcome = await harness.host.runToolDirect("runtime_reload", { scope: "extensions" });
		expect(outcome.status).toBe("succeeded");
		const details = outcome.details as { phase?: string; reloadId?: string } | undefined;
		expect(details?.phase).toBe("scheduled");
		expect(typeof details?.reloadId).toBe("string");
		expect(outcome.continuation).toBe("stop");
		expect(String(outcome.result)).toContain("尚未生效");
		// 空闲时受理后立即执行：完成报告以内部 runtime Input 恰好交付一次（轮询等待，
		// 不依赖固定时延）。
		await waitForCompletionReport(harness, details?.reloadId);
		const contents = harness.history.map((m) => String((m as { content?: string }).content ?? ""));
		const reports = contents.filter((text) => text.includes("扩展换代已完成"));
		expect(reports).toHaveLength(1);
		expect(reports[0]!).toContain(details?.reloadId?.slice(0, 8));
	});

	it("换代在回合结算后实施：屏障暂停自动续队，排队输入不丢不重排，新输入被准入门拒绝（A8）", async () => {
		const scenario = new Scenario({ id: "mock", name: "mock" });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		scenario
			.when(() => true)
			.thenStream(async (_m, _req, onDelta) => {
				await gate;
				onDelta({ kind: "text", text: "完成" });
				onDelta({ kind: "finish", reason: "stop" });
			});
		const harness = await createHarness(undefined, { scenario, autoStart: true });

		// 忙时排队一条 followUp（换代前已存在的原队列输入）。
		const busyTurn = harness.send("开始").catch(() => undefined);
		for (let i = 0; i < 50 && !harness.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		await harness.host.pushInput("排队输入", "followUp");

		// 受理换代：受理即有回执；准入门立即拒绝后续新输入（可见错误，不静默丢弃）。
		const { reloadId } = harness.host.scheduleExtensionsReload();
		expect(harness.events.filter("notice").some((e) => e.text.includes("扩展换代已受理"))).toBe(true);
		await expect(harness.host.submitText("换代期间的新输入", "direct")).rejects.toThrow(/重载/);
		expect(harness.queue.some((item) => item.text === "排队输入")).toBe(true);

		// 放行回合 → 回合结算后屏障生效：不自动续队，换代在 Idle 后执行。
		release();
		await busyTurn;
		await harness.waitForIdle();
		await waitForCompletionReport(harness, reloadId);

		// 完成报告恰好一次；原排队输入在换代后按原顺序继续处理。
		const contents = harness.history.map((m) => String((m as { content?: string }).content ?? ""));
		expect(contents.filter((text) => text.includes("扩展换代已完成")).length).toBe(1);
		expect(contents.some((text) => text.includes("排队输入"))).toBe(true);
		// reloadId 关联：完成报告携带同一身份。
		const report = contents.find((text) => text.includes("扩展换代已完成"));
		expect(report).toContain(reloadId.slice(0, 8));
	});
});

it("扩展换代后文件式 Guidance 登记随旧 Scope 移除，其后的资源刷新正常发布（A9）", async () => {
	const harness = await createHarness(async (env) => {
		await env.writeExtension("note-ext/index.mjs", FILE_GUIDANCE_EXTENSION);
		await env.writeFile(".uina/extensions/note-ext/prompts/note.md", "GUIDANCE-V1");
	});
	await harness.start();
	await harness.send("ping");
	expect(JSON.stringify(harness.scenario.calls[0]!.messages)).toContain("GUIDANCE-V1");

	// 项目扩展换代：旧 Scope 注销（登记必须随之移除），同一文件重新激活（新令牌）。
	const scheduled = await harness.host.runToolDirect("runtime_reload", { scope: "extensions" });
	expect(scheduled.status).toBe("succeeded");
	await waitForCompletionReport(harness, (scheduled.details as { reloadId?: string } | undefined)?.reloadId);
	await harness.waitForIdle();

	// 换代后的资源刷新必须正常发布——不能因陈旧登记整批失败。
	await harness.env.writeFile(".uina/extensions/note-ext/prompts/note.md", "GUIDANCE-V2");
	const outcome = await harness.host.runToolDirect("runtime_reload", { scope: "resources" });
	expect(outcome.status).toBe("succeeded");
	expect((outcome.details as { unchanged?: boolean } | undefined)?.unchanged).toBeUndefined();
	await harness.send("again");
	expect(JSON.stringify(harness.scenario.calls.at(-1)!.messages)).toContain("GUIDANCE-V2");
});

describe("资源版本一致性（A6）：装配期间换代不产生混版请求", () => {
	it("Context Source 读取期间发布新资源版本：放弃候选重新装配，发送完整新版本", async () => {
		const harness = await createHarness(
			async (env) => {
				await env.writeExtension("race-ext/index.mjs", RACE_EXTENSION);
				await env.writeFile(".uina/system.md", "# 系统 V1");
			},
			{ autoStart: true },
		);
		// 预改文件但不刷新：让 observation 触发的 reload 在装配中途发布 V2。
		await harness.env.writeFile(".uina/system.md", "# 系统 V2");

		await harness.send("race");
		const probeLine = harness.scenario.calls
			.at(-1)!
			.messages.filter((m) => String(m.content ?? "").includes("race-observation"))
			.map((m) => String(m.content))[0];
		// reload 在装配中途真实发布（probe 携带结果；unchanged=false）。
		expect(probeLine).toContain('"phase":"applied"');
		expect(probeLine).not.toContain('"unchanged":true');

		// 最终发送的请求必须是完整新版本（新 System），不允许旧 System 搭配新资源。
		const last = harness.scenario.calls.at(-1)!;
		const systemText = String(last.messages.find((m) => m.role === "system")?.content);
		expect(systemText).toContain("# 系统 V2");
		expect(systemText).not.toContain("# 系统 V1");
		// 已发布快照本身也必须是 V2（若这里失败而上面通过，说明发布与发送脱节）。
		expect(harness.host.getSystemSnapshot().text).toContain("# 系统 V2");
		// 活动请求观察与实际发送同版本。
		const observation = harness.host.getRequestObservation();
		expect(observation?.systemSource).toBe("workspace");
	});
});
