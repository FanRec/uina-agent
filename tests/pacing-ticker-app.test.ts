import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	pacingTickerApp,
	type TickerCompanionContext,
} from "../.uina/apps/pacing-ticker/src/index.js";
import type { ActionContext } from "../src/extensions/app-framework/types.js";

describe("pacingTickerApp (自主节拍器 App 契约与动作测试)", () => {
	let testDir: string;
	let currentTier: "hidden" | "ambient" | "expanded" = "ambient";

	const mockActionContext: ActionContext = {
		setTier: (tier) => {
			currentTier = tier;
		},
		getTier: () => currentTier,
		operationIdentity: "app:ticker/test" as const,
		signal: new AbortController().signal,
	};

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pacing-ticker-test-"));
		currentTier = "ambient";
		
	});

	afterEach(async () => {
		await pacingTickerApp.onStop?.({ signal: new AbortController().signal });
		await rm(testDir, { recursive: true, force: true }).catch(() => {});
	});

	it("AppDef 规范契约检查", () => {
		expect(pacingTickerApp.name).toBe("ticker");
		expect(pacingTickerApp.defaultState).toEqual({
			enabled: false,
			tier: "ambient",
		});
		expect(pacingTickerApp.actions).toHaveProperty("set_interval");
		expect(pacingTickerApp.actions).toHaveProperty("pause");
		expect(pacingTickerApp.actions).toHaveProperty("resume");
		expect(pacingTickerApp.actions).toHaveProperty("status");
	});

	it("未启动时动作容错：诚实返回未启动提示", async () => {
		const resSet = await pacingTickerApp.actions.set_interval.run({ minutes: 5 }, mockActionContext);
		expect(resSet).toContain("未启动");

		const resPause = await pacingTickerApp.actions.pause.run({ minutes: 10 }, mockActionContext);
		expect(resPause).toContain("未启动");

		const resResume = await pacingTickerApp.actions.resume.run({}, mockActionContext);
		expect(resResume).toContain("未启动");

		const resStatus = await pacingTickerApp.actions.status.run({}, mockActionContext);
		expect(JSON.parse(String(resStatus))).toEqual({ status: "stopped" });
	});

	it("动作校验：set_interval 参数校验与别名支持", async () => {
		const abortController = new AbortController();
		const ctx: TickerCompanionContext = {
			signal: abortController.signal,
			appDataDir: testDir,
		};

		await pacingTickerApp.onStart?.(ctx);

		// 1. 正常设置
		const res1 = await pacingTickerApp.actions.set_interval.run({ minutes: 10 }, mockActionContext);
		expect(res1).toContain("已将自主节拍基准周期调整为 10 分钟");
		expect(JSON.parse(String(await pacingTickerApp.actions.status.run({}, mockActionContext))).baseIntervalMinutes).toBe(10);

		// 2. 别名支持 (interval)
		const res2 = await pacingTickerApp.actions.set_interval.run({ interval: 5 }, mockActionContext);
		expect(res2).toContain("调整为 5 分钟");
		expect(JSON.parse(String(await pacingTickerApp.actions.status.run({}, mockActionContext))).baseIntervalMinutes).toBe(5);

		// 3. 超出范围校验 (< 1)
		const res3 = await pacingTickerApp.actions.set_interval.run({ minutes: 0 }, mockActionContext);
		expect(res3).toContain("参数错误");

		// 4. 超出范围校验 (> 120)
		const res4 = await pacingTickerApp.actions.set_interval.run({ minutes: 200 }, mockActionContext);
		expect(res4).toContain("参数错误");
	});

	it("动作校验：pause 与 resume 截止时间与诚实反馈", async () => {
		const abortController = new AbortController();
		const ctx: TickerCompanionContext = {
			signal: abortController.signal,
			appDataDir: testDir,
		};

		await pacingTickerApp.onStart?.(ctx);

		// 1. 未暂停时调用 resume，诚实反馈无需恢复
		const resResume1 = await pacingTickerApp.actions.resume.run({}, mockActionContext);
		expect(resResume1).toContain("无需恢复");

		// 2. 执行 pause
		const resPause = await pacingTickerApp.actions.pause.run({ minutes: 15 }, mockActionContext);
		expect(resPause).toContain("自主节拍已挂起 15 分钟");
		expect(JSON.parse(String(await pacingTickerApp.actions.status.run({}, mockActionContext))).status).toBe("paused");

		// 3. 暂停后再 resume，成功解除
		const resResume2 = await pacingTickerApp.actions.resume.run({}, mockActionContext);
		expect(resResume2).toContain("已提前解除挂起");
		expect(JSON.parse(String(await pacingTickerApp.actions.status.run({}, mockActionContext))).status).toBe("running");
	});

	it("动作校验：status 返回完整真实物理状态快照", async () => {
		const abortController = new AbortController();
		const ctx: TickerCompanionContext = {
			signal: abortController.signal,
			appDataDir: testDir,
		};

		await pacingTickerApp.onStart?.(ctx);

		const res = String(await pacingTickerApp.actions.status.run({}, mockActionContext));
		const data = JSON.parse(res);

		expect(data).toHaveProperty("status", "running");
		expect(data).toHaveProperty("baseIntervalMinutes", 3);
		expect(data).toHaveProperty("effectiveIntervalMinutes", 3);
		expect(data).toHaveProperty("idleMinutes");
		expect(data).toHaveProperty("remainingSeconds");
		expect(data).toHaveProperty("dailyAttempts", 0);
	});

	it("视口渲染：ambient 与 expanded 格式与 Token 经济学", async () => {
		const abortController = new AbortController();
		const ctx: TickerCompanionContext = {
			signal: abortController.signal,
			appDataDir: testDir,
		};

		// 未启动时视口为空
		expect(pacingTickerApp.render?.("ambient")).toBe("");
		expect(pacingTickerApp.render?.("expanded")).toBe("");

		await pacingTickerApp.onStart?.(ctx);

		// 1. ambient 视口 (~15 Tokens)
		const ambient = pacingTickerApp.render?.("ambient") ?? "";
		expect(ambient).toContain("[ticker]");
		expect(ambient).toContain("节拍: 3m");
		expect(ambient).toContain("静默:");

		// 2. expanded 视口 (纯数据结构化)
		const expanded = pacingTickerApp.render?.("expanded") ?? "";
		expect(expanded).toContain("[ticker]");
		expect(expanded).toContain("[/ticker]");
		expect(expanded).toContain("节拍: 基准 3m");
		expect(expanded).toContain("状态: 运行中");
		// 视口协议：expanded 禁装饰线与报时（每分钟漂移字段击穿缓存）
		expect(expanded).not.toContain("====");
		expect(expanded).not.toContain("=== [App:");
	});

	it("生命周期与护栏配置：安装目录不存在配置时保持无限制", async () => {

		const abortController = new AbortController();
		const ctx: TickerCompanionContext = {
			signal: abortController.signal,
			appDataDir: testDir,
		};

		await pacingTickerApp.onStart?.(ctx);
		expect(JSON.parse(String(await pacingTickerApp.actions.status.run({}, mockActionContext))).dailyAttemptsLimit).toBeNull();

		// 触发 abort 信号，引擎应被终止
		abortController.abort();
	});
});


