import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("注意力模型（v3：focus 集合 + off/pausedUntil 静音偏好）", () => {
	let dir: string;
	let control: ControlStore;
	let attention: AttentionModel;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-attention-"));
		control = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-11T12:00:00Z" });
		control.load();
		attention = new AttentionModel();
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

	it("focus 是内存态：新实例即重启后重置为空（冷启动无焦点）", () => {
		attention.setFocus([G1]);
		expect(attention.isFocused(G1)).toBe(true);
		const reborn = new AttentionModel();
		expect(reborn.focusList()).toEqual([]);
		expect(reborn.isFocused(G1)).toBe(false);
	});

	it("effectivePush：本地 off 或账号 off 任一即静音", () => {
		control.setPush(G1, { off: true });
		expect(control.effectivePush(G1).off).toBe(true);
		expect(control.effectivePush(G2).off).toBe(false);
		control.setPush("account", { off: true });
		expect(control.effectivePush(G2).off).toBe(true);
	});

	it("pausedUntil 未到期折算为 off，到期自然恢复", () => {
		control.setPush(G1, { pausedUntil: "2026-10-11T13:00:00Z" });
		expect(control.effectivePush(G1).off).toBe(true);
		expect(control.effectivePush(G1).pausedUntil).toBe("2026-10-11T13:00:00Z");
		control.setPush(G1, { pausedUntil: "2026-10-11T11:00:00Z" }); // 已过期
		expect(control.effectivePush(G1).off).toBe(false);
		control.setPush(G1, { pausedUntil: null }); // 显式解除
		expect(control.effectivePush(G1).pausedUntil).toBeNull();
	});

	it("setPush 只修改提供字段；clearPush 回落默认响铃", () => {
		control.setPush(G1, { off: true });
		control.setPush(G1, { pausedUntil: "2026-10-11T13:00:00Z" });
		expect(control.effectivePush(G1).off).toBe(true); // off 仍在
		control.setPush(G1, { off: false });
		expect(control.effectivePush(G1).off).toBe(true); // pausedUntil 仍在
		control.clearPush(G1);
		expect(control.effectivePush(G1)).toEqual({ off: false, pausedUntil: null });
	});

	it("v2 旧形状一次性迁移：mode off/silent → off:true", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "qq-control.json"),
			JSON.stringify({
				version: 2,
				selfId: SELF,
				revision: 3,
				accountPush: { mode: "digest" },
				conversationPush: { [G1]: { mode: "off" }, [P1]: { mode: "silent" } },
				initializationBaseline: {},
				followUps: {},
			}),
			"utf8",
		);
		control.load();
		expect(control.effectivePush("account").off).toBe(false); // digest 不映射静音
		expect(control.effectivePush(G1).off).toBe(true);
		expect(control.effectivePush(P1).off).toBe(true);
	});
});
