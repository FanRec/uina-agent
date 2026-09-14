import { describe, expect, it } from "vitest";
import { BranchInspectorOverlay } from "../src/ui/components/overlays/branch-inspector.js";
import type { SessionAccess } from "../src/session/types.js";

/**
 * 复现现场：Windows 工具结果（exec_command / read_file）的 content 带着物理
 * CRLF 行尾进入 session。detail 面板的 plainLines 只按 \n 切分，行尾 \r 残留在
 * 每个 detail 行末尾 —— 它是零宽控制字符，visibleWidth / truncateToWidth /
 * padTo 都看不见它，于是一路活着走到渲染器。写入端渲染器不剥 \r，终端收到
 * CR 就把光标回到行首（LF 再下移一行），整帧从那行起被软换行顶得错位：
 * 左列表前缀被覆盖、游离边框、标题消失 —— 用户截图的形态。
 */
describe("BranchInspectorOverlay：CRLF 详情不炸帧", () => {
	function makePort(content: string): SessionAccess {
		return {
			list: () => ({
				nodes: Array.from({ length: 20 }, (_, i) => ({
					id: `node-${i}`, parentId: null, seq: i + 1, kind: "message" as const,
					active: true, canRewind: false, preview: `节点 ${i}`,
				})),
			}),
			listBranches: () => ({ branches: [] }),
			readBranch: () => ({ branch: { id: "b", nodeCount: 0, reason: "" }, nodes: [] }),
			read: () => ({
				id: "node-3", parentId: null, seq: 4, timestamp: "t", kind: "message" as const,
				message: { role: "tool" as const, content },
			}),
			requestRewind: () => { throw new Error("not used"); },
		} as unknown as SessionAccess;
	}

	const CRLF_TOOL_OUTPUT = 'stdout 行一\r\nstdout 行二\r\n{"code":0}\r\n'.repeat(30);

	it("详情行不携带 CR（终端收到 CR 会从行首重写当前行）", () => {
		const overlay = new BranchInspectorOverlay(makePort(CRLF_TOOL_OUTPUT));
		overlay.render(96);
		overlay.handleInput("\x1b[B"); // ↓ 选中带 CRLF 的节点，detail 进入渲染
		const rows = overlay.render(96);
		const crlfRows = rows.filter((r) => r.includes("\r"));
		expect(crlfRows, `详情行携带物理 CR：\n${crlfRows.map((r) => JSON.stringify(r)).join("\n")}`).toEqual([]);
	});

	it("整帧行数不超预算（CR 引发的软换行会把后续行顶出视口）", () => {
		const overlay = new BranchInspectorOverlay(makePort(CRLF_TOOL_OUTPUT));
		overlay.handleInput("\x1b[B");
		const rows = overlay.render(96);
		expect(rows.length).toBeLessThanOrEqual(20);
	});
});
