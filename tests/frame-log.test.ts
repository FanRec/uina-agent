/**
 * 真机帧落盘器（诊断专用）：append 的开关、去重、限量与失败兜底。
 * append 本体是私有函数，经公开入口 logFrame/logNote 驱动；
 * 模块级 seen/seq 状态用 vi.resetModules + 动态导入逐测试隔离。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let file: string;

beforeEach(() => {
	vi.resetModules();
	dir = mkdtempSync(join(tmpdir(), "frame-log-"));
	file = join(dir, "frames.jsonl");
});

afterEach(() => {
	delete process.env["UINA_FRAME_LOG"];
	delete process.env["UINA_FRAME_LOG_MAX"];
	rmSync(dir, { recursive: true, force: true });
});

/** 每次拿全新的 frame-log 模块（seen/seq 归零） */
async function load() {
	return import("../src/ui/core/frame-log.js");
}

function lines(): string[] {
	return existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n") : [];
}

describe("帧落盘器 append（经 logFrame/logNote）", () => {
	it("开关关闭时零写入、零副作用", async () => {
		const { logFrame, logNote } = await load();
		logFrame("frame-a", 80, 24);
		logNote("note-a", { cols: 80 });
		expect(existsSync(file)).toBe(false);
	});

	it("开启后帧落盘，seq 递增，相同帧去重，不同帧保留", async () => {
		const { logFrame } = await load();
		process.env["UINA_FRAME_LOG"] = file;
		logFrame("same-frame", 80, 24);
		logFrame("same-frame", 80, 24);
		logFrame("other-frame", 80, 24);
		const all = lines();
		expect(all).toHaveLength(2);
		const parsed = all.map((l) => JSON.parse(l));
		expect(parsed[0]).toMatchObject({ kind: "frame", cols: 80, rows: 24, data: "same-frame", seq: 0 });
		expect(parsed[1]!.seq).toBe(1);
		// 相同内容不同尺寸不去重（几何也是帧身份的一部分）
		logFrame("same-frame", 100, 30);
		expect(lines()).toHaveLength(3);
	});

	it("UINA_FRAME_LOG_MAX 限制唯一帧数量，超限丢弃", async () => {
		const { logFrame } = await load();
		process.env["UINA_FRAME_LOG"] = file;
		process.env["UINA_FRAME_LOG_MAX"] = "2";
		logFrame("f1", 80, 24);
		logFrame("f2", 80, 24);
		logFrame("f3", 80, 24);
		expect(lines()).toHaveLength(2);
		// 去重命中不占新名额，已有帧仍可继续命中
		logFrame("f1", 80, 24);
		expect(lines()).toHaveLength(2);
	});

	it("max=0 表示不限制唯一帧数量", async () => {
		const { logFrame } = await load();
		process.env["UINA_FRAME_LOG"] = file;
		process.env["UINA_FRAME_LOG_MAX"] = "0";
		for (let i = 0; i < 5; i++) logFrame(`frame-${i}`, 80, 24);
		expect(lines()).toHaveLength(5);
	});

	it("非帧探针记录不受去重与限量约束", async () => {
		const { logFrame, logNote } = await load();
		process.env["UINA_FRAME_LOG"] = file;
		process.env["UINA_FRAME_LOG_MAX"] = "1";
		logNote("size-report", { cols: 80, rows: 24 });
		logNote("size-report", { cols: 80, rows: 24 });
		logFrame("only-frame", 80, 24);
		logFrame("dropped-frame", 80, 24);
		const all = lines();
		expect(all.filter((l) => l.includes("size-report"))).toHaveLength(2);
		expect(all.filter((l) => l.includes("only-frame"))).toHaveLength(1);
		expect(all.filter((l) => l.includes("dropped-frame"))).toHaveLength(0);
	});

	it("写盘失败静默吞掉，绝不影响调用方", async () => {
		const { logFrame, logNote } = await load();
		// 把"文件"路径当目录用：mkdirSync 会撞上已存在的普通文件
		const blocker = join(dir, "not-a-dir");
		writeFileSync(blocker, "x");
		process.env["UINA_FRAME_LOG"] = join(blocker, "nested", "frames.jsonl");
		expect(() => logFrame("frame-x", 80, 24)).not.toThrow();
		expect(() => logNote("note-x", {})).not.toThrow();
	});
});
