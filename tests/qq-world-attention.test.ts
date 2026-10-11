import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { conversationRef } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001";
const G1 = conversationRef("group", "30003");
const G2 = conversationRef("group", "30004");
const P1 = conversationRef("private", "20002");

describe("注意力模型（设计 §1.2 双态在场）", () => {
	let dir: string;
	let control: ControlStore;
	let attention: AttentionModel;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-attention-"));
		control = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-11T12:00:00Z" });
		control.load();
		attention = new AttentionModel({ control });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("focus 原子替换；非法会话引用显式失败", () => {
		attention.setFocus([G1, P1]);
		expect(attention.focusList()).toEqual([G1, P1]);
		attention.setFocus([G2]);
		expect(attention.focusList()).toEqual([G2]);
		attention.setFocus([]);
		expect(attention.focusList()).toEqual([]);
		expect(() => attention.setFocus(["not-a-ref"])).toThrow(/非法会话引用/);
	});

	it("effectiveFollow = isFocused && resolvedPushMode === follow（缺一不可）", () => {
		control.setPush(G1, { mode: "follow" });
		expect(attention.effectiveFollow(G1)).toBe(false); // 有配置无视线
		attention.setFocus([G1]);
		expect(attention.effectiveFollow(G1)).toBe(true);
		expect(attention.effectiveFollow(G2)).toBe(false); // 有视线未配置 follow
	});

	it("inherit 链：会话 inherit 回落账号 follow", () => {
		control.setPush("account", { mode: "follow" });
		attention.setFocus([P1]);
		expect(attention.effectiveFollow(P1)).toBe(true);
		control.setPush("account", { mode: "digest" });
		expect(attention.effectiveFollow(P1)).toBe(false);
	});

	it("focus 是内存态：新实例即重启后重置为空（T14 冷启动无焦点）", () => {
		control.setPush(G1, { mode: "follow" });
		attention.setFocus([G1]);
		expect(attention.effectiveFollow(G1)).toBe(true);
		const reborn = new AttentionModel({ control });
		expect(reborn.focusList()).toEqual([]);
		expect(reborn.effectiveFollow(G1)).toBe(false);
	});

	it("放下视线切断跟读，持久化 push.mode 原封不动（T13）", () => {
		control.setPush(G1, { mode: "follow" });
		attention.setFocus([G1]);
		expect(attention.effectiveFollow(G1)).toBe(true);
		attention.setFocus([]);
		expect(attention.effectiveFollow(G1)).toBe(false);
		expect(control.effectivePush(G1).mode).toBe("follow");
	});
});
