/**
 * W4 槽位契约：每个对外展示接口必须有读取端与回执；中立层无渲染函数。
 *
 * - SlotRegistry：toast 队列、去重、淘汰、activity 并列、header/footer 覆盖、TTL 过期；
 * - 读取端枚举：ExtensionUIContext 的展示接口都有 src/ui 内的消费者；
 * - setStatus 已删除，全仓（src）无引用。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlotRegistry, type SlotContribution } from "../src/presentation/composition/slots.js";

const T0 = 1_700_000_000_000;

function toast(id: string, text: string, priority = 10, dedupeKey?: string): SlotContribution {
	return {
		id,
		slot: "toast",
		priority,
		ttlMs: 3000,
		...(dedupeKey === undefined ? {} : { dedupeKey }),
		payload: { kind: "notice", text, level: "info", ...(dedupeKey === undefined ? {} : { dedupeKey }) },
	};
}

describe("SlotRegistry：toast 队列（C2）", () => {
	it("三条并发通知全部可见，不再互相覆盖", () => {
		const registry = createSlotRegistry();
		expect(registry.publish(toast("t1", "一"), T0).accepted).toBe(true);
		expect(registry.publish(toast("t2", "二"), T0).accepted).toBe(true);
		expect(registry.publish(toast("t3", "三"), T0).accepted).toBe(true);
		const snapshot = registry.snapshot("toast");
		expect(snapshot.map((c) => c.payload).map((p) => (p.kind === "notice" ? p.text : ""))).toEqual(["三", "二", "一"]);
	});

	it("第四条挤掉优先级最低的一条，容量恒为 3", () => {
		const registry = createSlotRegistry();
		registry.publish(toast("t1", "低", 1), T0);
		registry.publish(toast("t2", "中", 20), T0);
		registry.publish(toast("t3", "高", 30), T0);
		registry.publish(toast("t4", "新", 5), T0);
		const texts = registry
			.snapshot("toast")
			.map((c) => c.payload)
			.map((p) => (p.kind === "notice" ? p.text : ""));
		expect(texts).toContain("高");
		expect(texts).toContain("新");
		expect(texts).not.toContain("低");
		expect(texts).toHaveLength(3);
	});

	it("同 dedupeKey 的通知被去重并回执 shadowed", () => {
		const registry = createSlotRegistry();
		expect(registry.publish(toast("t1", "同一句话", 10, "同一句话"), T0).accepted).toBe(true);
		const ack = registry.publish(toast("t2", "同一句话", 10, "同一句话"), T0);
		expect(ack).toEqual({ accepted: false, reason: "shadowed" });
		expect(registry.snapshot("toast")).toHaveLength(1);
	});

	it("TTL 由 surface 心跳推进：expire(at) 返回过期 id 并移除", () => {
		const registry = createSlotRegistry();
		registry.publish(toast("t1", "一"), T0);
		registry.publish(toast("t2", "二"), T0 + 2000);
		expect(registry.expire(T0 + 2999)).toEqual([]);
		expect(registry.expire(T0 + 3000)).toEqual(["t1"]);
		expect(registry.snapshot("toast").map((c) => c.id)).toEqual(["t2"]);
	});
});

describe("SlotRegistry：activity 并列（C6）与 header/footer 覆盖", () => {
	it("多个工作指示按优先级并列，回执受理", () => {
		const registry = createSlotRegistry();
		expect(
			registry.publish(
				{ id: "a:1", slot: "activity", priority: 100, payload: { kind: "activity", label: "压缩中", startedAt: T0 } },
				T0,
			).accepted,
		).toBe(true);
		registry.publish(
			{ id: "a:2", slot: "activity", priority: 90, payload: { kind: "activity", label: "等待世界" } },
			T0,
		);
		const snapshot = registry.snapshot("activity");
		expect(snapshot).toHaveLength(2);
		expect(snapshot[0]!.id).toBe("a:1");
	});

	it("setWorking 同 key upsert：startedAt 保留首次起点", () => {
		const registry = createSlotRegistry();
		registry.publish(
			{ id: "a:c", slot: "activity", priority: 100, payload: { kind: "activity", label: "一", startedAt: T0 } },
			T0,
		);
		registry.publish(
			{ id: "a:c", slot: "activity", priority: 100, payload: { kind: "activity", label: "二", startedAt: T0 + 500 } },
			T0 + 1000,
		);
		const snapshot = registry.snapshot("activity");
		expect(snapshot).toHaveLength(1);
		const payload = snapshot[0]!.payload;
		expect(payload.kind === "activity" && payload.label).toBe("二");
	});

	it("header/footer 最新覆盖", () => {
		const registry = createSlotRegistry();
		registry.publish({ id: "h:1", slot: "header", priority: 1, payload: { kind: "text", text: "旧" } }, T0);
		registry.publish({ id: "h:2", slot: "header", priority: 1, payload: { kind: "text", text: "新" } }, T0);
		const snapshot = registry.snapshot("header");
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]!.payload.kind === "text" && snapshot[0]!.payload.text).toBe("新");
	});

	it("retract 撤回；snapshot 全量与分槽一致", () => {
		const registry = createSlotRegistry();
		registry.publish(toast("t1", "一"), T0);
		registry.retract("t1");
		expect(registry.snapshot("toast")).toHaveLength(0);
		expect(registry.snapshot()).toHaveLength(0);
	});
});

describe("槽位契约：读取端枚举与删除清单", () => {
	function walkSource(dir: string): string[] {
		const files: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) files.push(...walkSource(full));
			else if (entry.name.endsWith(".ts")) files.push(full);
		}
		return files;
	}

	it("ExtensionUIContext 的每个展示接口都有 src 内读取端（H1）", () => {
		const sources = walkSource(join(import.meta.dirname, "../src")).map((f) => readFileSync(f, "utf8"));
		const joined = sources.join("\n");
		for (const reader of [".notify(", ".setWorking(", ".setHeader(", ".setFooter("]) {
			expect(joined.includes(reader), `接口 ${reader} 无读取端`).toBe(true);
		}
	});

	it("setStatus 与 statuses 已删除，全仓 src 无引用（C4）", () => {
		const offenders = walkSource(join(import.meta.dirname, "../src")).filter((f) => {
			const text = readFileSync(f, "utf8");
			return text.includes(".setStatus(") || text.includes("statuses");
		});
		expect(offenders).toEqual([]);
	});

	it("SlotContribution 无渲染函数、无 Component（B.4）", () => {
		const contribution: SlotContribution = toast("t", "一");
		// 任意载荷值都不允许是函数（渲染函数/组件都进不了中立贡献）
		for (const value of Object.values(contribution)) {
			expect(
				typeof value === "function" ||
					(typeof value === "object" && value !== null && Object.values(value).some((v) => typeof v === "function")),
			).toBe(false);
		}
		expect(contribution).not.toHaveProperty("render");
	});
});
