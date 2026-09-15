/**
 * RC-1 验收：主体生命期不属于任何消费者。
 *
 * 这些是**反例**：它们证明的不是“能跑通”，而是“没有 UI 也能跑通”、
 * “零消费者状态下主体照常工作”、以及“第二个观察者能拿到它接入后的事件流”。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UinaHost } from "../src/host/host.js";
import type { HostEvent } from "../src/host/events.js";
import { scriptedProvider, createMockProvider, mockModel } from "./helpers/mock-provider.js";
import type { ModelRequest, StreamDelta } from "../src/core/types.js";

/** 一个普通项目扩展：注册一个工具。扩展装载也一并被这条路径验证。 */
const PROJECT_EXTENSION = `
export default function activate(uina) {
  uina.registerTool({
    def: {
      type: "function",
      function: {
        name: "probe_echo",
        description: "回显传入文本",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      },
    },
    async run(args) { return { result: args.text, status: "succeeded" }; },
  });
}
`;

const hasToolResult = (req: ModelRequest): boolean => req.messages.some((m) => m.role === "tool");

/** 第一轮请求工具，拿到结果后第二轮返回文本。 */
function probeProvider() {
	return scriptedProvider([
		{
			match: (req) => !hasToolResult(req),
			produce: () => [{ kind: "tool_call", call: { id: "call-1", name: "probe_echo", args: JSON.stringify({ text: "你好" }) } }],
		},
		{
			match: (req) => hasToolResult(req),
			produce: (): StreamDelta[] => [{ kind: "text", text: "工具已返回" }],
		},
	]);
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeHost(options: { sessionPath?: string } = {}): Promise<UinaHost> {
	const cwd = await mkdtemp(join(tmpdir(), "uina-host-"));
	dirs.push(cwd);
	await mkdir(join(cwd, ".uina", "extensions"), { recursive: true });
	await writeFile(join(cwd, ".uina", "extensions", "probe.mjs"), PROJECT_EXTENSION, "utf8");
	const probe = probeProvider();
	const host = await UinaHost.create({ cwd, provider: probe, model: probe.model, ...options });
	await host.start();
	return host;
}

async function runOnce(host: UinaHost, text: string): Promise<void> {
	await host.submitText(text, "direct");
	await host.waitForIdle();
}

describe("RC-1 宿主与消费者分离", () => {
	it("不创建任何 UI，注入假消费者即可跑通 文本 → 工具调用 → 结果回注", async () => {
		const host = await makeHost();
		const events: HostEvent[] = [];
		// 全程没有 TUI、没有 stdio：消费者就是一个数组。
		host.subscribe((event) => events.push(event));

		await runOnce(host, "调用工具");

		expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
		const started = events.find((e) => e.type === "tool_start");
		expect(started).toMatchObject({ type: "tool_start", name: "probe_echo" });
		const done = events.find((e) => e.type === "tool_done");
		expect(done).toMatchObject({ name: "probe_echo", result: "你好", status: "succeeded" });
		// 计时归宿主：消费者不再各自维护一张并行的工具计时表。
		expect(typeof (done as { elapsedMs?: number }).elapsedMs).toBe("number");
		const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
		expect(text).toContain("工具已返回");
		expect(events.at(-1)?.type).toBe("turn_end");
		await host.dispose();
	});

	it("零消费者状态下主体照常工作，之后接入的观察者能拿到新事件", async () => {
		const host = await makeHost();
		const first: HostEvent[] = [];
		const unsubscribe = host.subscribe((event) => first.push(event));
		await runOnce(host, "第一次");
		const seenByFirst = first.length;
		const historyAfterFirst = host.historyCount();
		expect(seenByFirst).toBeGreaterThan(0);

		// 断开唯一的消费者。如果生命期属于 UI，主体到这里就该死了。
		unsubscribe();

		// 在**零消费者**状态下完整跑一轮：事件没有去处，但主体必须照常工作。
		await runOnce(host, "第二次");
		expect(host.historyCount()).toBeGreaterThan(historyAfterFirst);

		// 之后接入的新观察者，拿到的是它接入之后的运行。
		const second: HostEvent[] = [];
		host.subscribe((event) => second.push(event));
		await runOnce(host, "第三次");

		expect(first).toHaveLength(seenByFirst); // 已断开的消费者不再收到任何事件
		const turnStart = second.find((e) => e.type === "turn_start");
		expect(turnStart).toMatchObject({ type: "turn_start", text: "第三次" });
		expect(second.at(-1)?.type).toBe("turn_end");
		await host.dispose();
	});

	it("会话由宿主拥有：dispose 后重开能恢复历史", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "uina-host-"));
		dirs.push(cwd);
		const sessionPath = join(cwd, "session.jsonl");

		const probe1 = probeProvider();
		const first = await UinaHost.create({ cwd, sessionPath, provider: probe1, model: probe1.model });
		await first.start();
		await runOnce(first, "写进日志");
		const beforeDispose = first.historyCount();
		expect(beforeDispose).toBeGreaterThan(0);
		await first.dispose();

		const probe2 = probeProvider();
		const second = await UinaHost.create({ cwd, sessionPath, provider: probe2, model: probe2.model });
		await second.start();
		expect(second.restoredEntries.length).toBeGreaterThan(0);
		expect(second.historyCount()).toBe(beforeDispose);
		await second.dispose();
	});
});
describe("/reload 反馈", () => {
	async function makeReloadHost(): Promise<{ host: UinaHost; cwd: string }> {
		const cwd = await mkdtemp(join(tmpdir(), "uina-host-"));
		dirs.push(cwd);
		await mkdir(join(cwd, ".uina", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".uina", "extensions", "probe.mjs"), PROJECT_EXTENSION, "utf8");
		const probe = probeProvider();
		const host = await UinaHost.create({ cwd, provider: probe, model: probe.model });
		await host.start();
		return { host, cwd };
	}

	it("完成通知带扩展摘要：成功数量与失败数量", async () => {
		const { host, cwd } = await makeReloadHost();
		await writeFile(join(cwd, ".uina", "extensions", "bad.mjs"), "export default function () { throw new Error('broken'); }", "utf8");
		const events: HostEvent[] = [];
		host.subscribe((event) => events.push(event));

		await host.reloadExtensions();

		const notices = events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text);
		const summary = notices.find((text) => text.includes("项目扩展已重新加载"));
		expect(summary).toBeDefined();
		expect(summary!).toContain("1 个扩展");
		expect(summary!).toContain("失败 1");
		expect(summary!).toContain("bad.mjs");
		await host.dispose();
	});

	it("忙时提交 /reload：本轮结束后才执行，且受理即有回执", async () => {
		// 门控 provider：回合卡在 stream 内部，直到测试放行，确保 dispatch 时宿主确实在忙
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const cwd = await mkdtemp(join(tmpdir(), "uina-host-"));
		dirs.push(cwd);
		await mkdir(join(cwd, ".uina", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".uina", "extensions", "probe.mjs"), PROJECT_EXTENSION, "utf8");
		const gatedProvider = createMockProvider(async (_m, _req, onDelta) => {
			await gate;
			onDelta({ kind: "text", text: "完成" });
			onDelta({ kind: "finish", reason: "stop" });
		});
		const host = await UinaHost.create({ cwd, provider: gatedProvider, model: mockModel() });
		await host.start();
		const events: HostEvent[] = [];
		host.subscribe((event) => events.push(event));

		// 让宿主进入忙碌状态（不 await：submitText 会等回合结束，门控下它会一直阻塞）
		const turnSettled = host.submitText("开始", "direct").catch(() => undefined);
		for (let i = 0; i < 50 && !host.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(host.isBusy()).toBe(true);

		await host.commands.dispatch("/reload");

		// 受理回执立即出现，且此刻 reload 尚未执行（仍在忙）
		const earlyNotices = events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text);
		expect(earlyNotices.some((text) => text.includes("本轮结束后") && text.includes("重新加载"))).toBe(true);
		expect(events.some((e) => e.type === "notice" && (e as { text: string }).text.includes("已重新加载"))).toBe(false);
		expect(host.isBusy()).toBe(true);

		// 放行回合 → reload 自动执行，带摘要的成功通知出现
		release();
		await turnSettled;
		await host.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const notices = events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text);
		expect(notices.some((text) => text.includes("项目扩展已重新加载"))).toBe(true);
		await host.dispose();
	});
});
