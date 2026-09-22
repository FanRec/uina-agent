/**
 * 瞬态世界快照守卫（viewport-event-frame-refactor.md:29 "不落 Session 历史"）：
 * app-viewport / embodiment-state 的 runtime 输入在 Subject.accept 入口被丢弃——
 * 同一内容由 tail 相位帧每请求注入（app-registry.ts buildTailFrame），历史副本是冗余。
 * 客户端侧重复投递从此无害：不进队列、不落史、不启动回合。
 */
import { describe, expect, it } from "vitest";
import { SubjectHarness, mockModel, Scenario } from "./harness/index.js";
import type { ModelRequest, ModelStreamFn } from "../src/core/types.js";

const snapshotInput = (type: string, id: string) => ({
	id,
	mode: "followUp" as const,
	source: { kind: "runtime" as const, type, origin: "external" as const },
	text: `[瞬态快照] ${type} 的内容（不应进入历史）`,
});

describe("瞬态世界快照守卫", () => {
	it("app-viewport / embodiment-state 输入被丢弃：不落史、不启动回合", async () => {
		const requests: ModelRequest[] = [];
		const scenario = Scenario.create().reply("ack");
		const stream: ModelStreamFn = async (model, req, onDelta, signal) => {
			requests.push(req as ModelRequest);
			return scenario.stream(model, req, onDelta, signal);
		};
		const harness = SubjectHarness.create({ model: mockModel(), stream });

		await harness.subject.accept(snapshotInput("app-viewport", "snap-1"));
		await harness.subject.accept(snapshotInput("embodiment-state", "snap-2"));

		expect(harness.historySnapshot()).toHaveLength(0);
		expect(requests).toHaveLength(0);
	});

	it("普通输入不受守卫影响，照常驱动回合", async () => {
		const requests: ModelRequest[] = [];
		const scenario = Scenario.create().reply("ack");
		const stream: ModelStreamFn = async (model, req, onDelta, signal) => {
			requests.push(req as ModelRequest);
			return scenario.stream(model, req, onDelta, signal);
		};
		const harness = SubjectHarness.create({ model: mockModel(), stream });

		await harness.run("正常输入");
		expect(requests).toHaveLength(1);
		expect(harness.historySnapshot().length).toBeGreaterThan(0);
	});
});
