/**
 * RC-1 验收：主体生命期不属于任何消费者。
 *
 * 这些是**反例**：它们证明的不是“能跑通”，而是“没有 UI 也能跑通”、
 * “零消费者状态下主体照常工作”、以及“第二个观察者能拿到它接入后的事件流”。
 *
 * 基于 Uina Test Kit 进行统一治理，消灭手工 mkdtemp/dirs 样板。
 */
import { describe, expect, test } from "./harness/index.js";
import type { HostEvent } from "../src/host/events.js";

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

describe("RC-1 宿主与消费者分离", () => {
	test("不创建任何 UI，注入假消费者即可跑通 文本 → 工具调用 → 结果回注", async ({ uina, scenario, env }) => {
		await env.writeExtension("probe.mjs", PROJECT_EXTENSION);
		await uina.start(); // 激活项目扩展

		scenario
			.replyWithToolCall("call-1", "probe_echo", { text: "你好" })
			.reply("工具已返回");

		await uina.send("调用工具");
		await uina.waitForIdle();

		const events = uina.events.all;
		expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
		const started = events.find((e) => e.type === "tool_call");
		expect(started).toMatchObject({ type: "tool_call", toolName: "probe_echo" });
		const done = events.find((e) => e.type === "tool_result");
		expect(done).toMatchObject({ toolName: "probe_echo", result: "你好", status: "succeeded" });

		const text = events
			.filter((e): e is Extract<typeof e, { type: "output_update" }> => e.type === "output_update" && e.channel === "content")
			.map((e) => e.text).join("");
		expect(text).toContain("工具已返回");

		// 事实单流 1:1 透传后，消费者能看到回合收尾的完整事实序列：turn_end 之后
		// 是 agent_end（回合结果）与 agent_settled（副作用结算完成）。
		expect(events.some((e) => e.type === "turn_end")).toBe(true);
		expect(events.at(-1)?.type).toBe("agent_settled");
		expect(uina).toConformToDAG();
	});

	test("零消费者状态下主体照常工作，之后接入的观察者能拿到新事件", async ({ uina, scenario }) => {
		scenario
			.reply("一")
			.reply("二")
			.reply("三");

		const first: HostEvent[] = [];
		const unsubscribe = uina.host.subscribe((event) => first.push(event));

		await uina.send("第一次");
		await uina.waitForIdle();
		const seenByFirst = first.length;
		const historyAfterFirst = uina.host.historyCount();
		expect(seenByFirst).toBeGreaterThan(0);

		// 断开唯一的消费者。如果生命期属于 UI，主体到这里就该死了。
		unsubscribe();

		// 在**零消费者**状态下完整跑一轮：事件没有去处，但主体必须照常工作。
		await uina.send("第二次");
		await uina.waitForIdle();
		expect(uina.host.historyCount()).toBeGreaterThan(historyAfterFirst);

		// 之后接入的新观察者，拿到的是它接入之后的运行。
		const second: HostEvent[] = [];
		uina.host.subscribe((event) => second.push(event));

		await uina.send("第三次");
		await uina.waitForIdle();

		expect(first).toHaveLength(seenByFirst); // 已断开的消费者不再收到任何事件
		const turnStart = second.find((e) => e.type === "turn_start");
		expect(turnStart).toMatchObject({ type: "turn_start", userText: "第三次" });
		expect(second.at(-1)?.type).toBe("agent_settled");
	});

	test("会话由宿主拥有：dispose 后重开能恢复历史", async ({ uina, scenario }) => {
		scenario.reply("已记录");

		await uina.send("写进日志");
		await uina.waitForIdle();
		const beforeDispose = uina.host.historyCount();
		expect(beforeDispose).toBeGreaterThan(0);

		// 基于同一 session 文件重启宿主
		const restarted = await uina.restart();
		expect(restarted.host.restoredEntries.length).toBeGreaterThan(0);
		expect(restarted.host.historyCount()).toBe(beforeDispose);
	});
});

describe("/reload 反馈", () => {
	test("完成通知带扩展摘要：成功数量与失败数量", async ({ uina, env }) => {
		await env.writeExtension("probe.mjs", PROJECT_EXTENSION);
		await env.writeExtension("bad.mjs", "export default function () { throw new Error('broken'); }");
		await uina.start();

		await uina.host.reloadExtensions();

		const notices = uina.events.filter("notice").map((e) => e.text);
		const summary = notices.find((text) => text.includes("项目扩展已重新加载"));
		expect(summary).toBeDefined();
		expect(summary!).toContain("1 个扩展");
		expect(summary!).toContain("失败 1");
		expect(summary!).toContain("bad.mjs");
	});

	test("忙时提交 /reload：本轮结束后才执行，且受理即有回执", async ({ uina, scenario, env }) => {
		await env.writeExtension("probe.mjs", PROJECT_EXTENSION);
		await uina.start();

		// 门控 provider：回合卡在 stream 内部，直到测试放行，确保 dispatch 时宿主确实在忙
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });

		scenario.when(() => true).thenStream(async (_m, _req, onDelta) => {
			await gate;
			onDelta({ kind: "text", text: "完成" });
			onDelta({ kind: "finish", reason: "stop" });
		});

		// 让宿主进入忙碌状态（不 await：submitText 会等回合结束，门控下它会一直阻塞）
		const turnSettled = uina.host.submitText("开始", "direct").catch(() => undefined);
		for (let i = 0; i < 50 && !uina.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(uina.isBusy()).toBe(true);

		await uina.host.commands.dispatch("/reload");

		// 受理回执立即出现，且此刻 reload 尚未执行（仍在忙）
		const earlyNotices = uina.events.filter("notice").map((e) => e.text);
		expect(earlyNotices.some((text) => text.includes("本轮结束后") && text.includes("重新加载"))).toBe(true);
		expect(uina.events.filter("notice").some((e) => e.text.includes("已重新加载"))).toBe(false);
		expect(uina.isBusy()).toBe(true);

		// 放行回合 → reload 自动执行，带摘要的成功通知出现
		release();
		await turnSettled;
		await uina.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const notices = uina.events.filter("notice").map((e) => e.text);
		expect(notices.some((text) => text.includes("项目扩展已重新加载"))).toBe(true);
	});
});
