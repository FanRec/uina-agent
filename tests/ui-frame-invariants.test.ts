/**
 * W0 帧不变量：任何宽度下写进终端的每一行都必须满足结构约束。
 *
 * - 每行可视宽度 <= 终端宽度（渲染器负责截断，这里验证宽度表没骗人）；
 * - 行内不残留 ESC / OSC / C0 / CR / LF / DEL（注入与换行必须在校验前处理）；
 * - 每行以 SGR reset 开始、以 reset + EL 收尾（相邻行颜色不串）。
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "../src/ui/core/utils.js";
import { UIHost } from "../src/ui/ui-host.js";
import { createSilentTerminal, toolDoneNode, toolStartNode } from "./harness/index.js";

const SGR = /\x1b\[[0-9;]*m/g;
const CUP = /\x1b\[[0-9]+;1H/;
/** 渲染器的行尾收尾：先 reset 再 EL，之后可能追加硬件光标定位（仅末行）。 */
const ROW_END = "\x1b[0m\x1b[K";
/** 满宽行在收尾前先绝对定位到行末列，离开 pending-wrap 边界。 */
const FULL_WIDTH_CUP = /\x1b\[[0-9]+;[0-9]+H$/;
/** 末行之后的硬件光标收尾。 */
const CURSOR_TRAILER = /^(?:\x1b\[[0-9]+;[0-9]+H\x1b\[\?25h|\x1b\[\?25l)$/;

const CJK = "长中文内容需要按字素测量宽度，不能把 UTF-16 长度当显示宽度。".repeat(4);
const EMOJI = "🙂👨‍👩‍👧‍👦🚀⌚⚽";
const INJECTION = "恶意\x1b]8;;https://evil.example\x07链接\x1b]8;;\x07\x1b[31m红色\x1b[0m\u202E反向\r覆盖";
const MARKDOWN = [
	"| 列一 | 列二 |",
	"| --- | --- |",
	"| `C:\\Users\\x` | 中文 |",
	"",
	"```ts",
	"const path = 'C:\\\\Users\\\\x';",
	"```",
].join("\n");

const STATUSES = ["succeeded", "failed", "cancelled", "unknown", "not_started"] as const;

function populate(host: UIHost): void {
	host.transcript.startTurn(1, `${CJK}${EMOJI}`);
	host.transcript.appendThinking(`${INJECTION}\n${CJK}`);
	host.transcript.appendToken(`${MARKDOWN}\n${INJECTION}\n${CJK}${EMOJI}`);
	STATUSES.forEach((status, index) => {
		const callId = `call-${index}`;
		host.transcript.startTool(toolStartNode("exec_command", { command: `${CJK} ${EMOJI}` }, callId));
		host.transcript.addToolDone(
			toolDoneNode("exec_command", JSON.stringify({ stdout: `${CJK}\n${INJECTION}\n${EMOJI}` }), 1234, status, callId, {
				command: "echo 中文",
			}),
		);
	});
	host.addCompaction({
		status: "failed",
		summary: "上下文压缩失败，继续使用原历史",
		retainedTailEntries: 0,
		tokensBefore: 0,
		collapsed: false,
	});
	host.notify("三条通知并发：一", "info", 1000);
	host.notify("三条通知并发：二", "warning", 1000);
	host.notify("三条通知并发：三", "error", 1000);
	host.setWorking("probe", "后台任务进行中");
	host.setPendingQueue([{ mode: "followUp", text: "排队中的输入".repeat(6) }]);
}

interface RowViolation {
	readonly row: number;
	readonly reason: string;
	readonly text: string;
}

async function inspect(width: number, height: number): Promise<RowViolation[]> {
	const { terminal, frames } = createSilentTerminal(width, height);
	const host = new UIHost({ terminal, modelName: "TestModel" });
	host.start();
	populate(host);
	host.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 80));
	const frame = frames.at(-1);
	if (frame === undefined) return [{ row: -1, reason: "没有渲染帧", text: "" }];
	host.stop();

	const rows = frame.split(CUP).slice(1);
	const violations: RowViolation[] = [];
	if (rows.length !== height) {
		violations.push({ row: -1, reason: `帧行数 ${rows.length} != ${height}`, text: "" });
	}
	rows.forEach((segment, index) => {
		const endIndex = segment.lastIndexOf(ROW_END);
		if (endIndex < 0) {
			violations.push({ row: index, reason: "行尾缺少 reset+EL", text: segment.slice(0, 60) });
			return;
		}
		// 行内容 = 收尾之前的部分；满宽行的定位属于收尾，不属于内容。
		const head = segment.slice(0, endIndex);
		const after = segment.slice(endIndex + ROW_END.length);
		const fullWidth = FULL_WIDTH_CUP.test(head);
		const content = fullWidth ? head.replace(FULL_WIDTH_CUP, "") : head;
		const text = content.replace(SGR, "");
		const row = index;

		if (after !== "") {
			if (index !== rows.length - 1) violations.push({ row, reason: "非末行出现光标收尾", text: after });
			else if (!CURSOR_TRAILER.test(after)) violations.push({ row, reason: "非法光标收尾", text: after });
		}
		if (!content.startsWith("\x1b[0m")) violations.push({ row, reason: "行首缺少 SGR reset", text: text.slice(0, 60) });
		if (text.includes("\x1b")) violations.push({ row, reason: "残留非 SGR 转义", text: text.slice(0, 60) });
		if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
			violations.push({ row, reason: "残留 C0/CR/LF/DEL", text: text.slice(0, 60) });
		}
		const emitted = visibleWidth(content);
		if (emitted > width) violations.push({ row, reason: `宽度 ${emitted} > ${width}`, text: text.slice(0, 60) });
		// 渲染器只在内容满宽时改走绝对定位收尾；不满宽的行必须留出最后一格。
		if (fullWidth && emitted !== width) {
			violations.push({ row, reason: `满宽行实际宽度 ${emitted} != ${width}`, text: text.slice(0, 60) });
		}
		if (!fullWidth && emitted >= width) {
			violations.push({ row, reason: `未定位行宽度 ${emitted} >= ${width}`, text: text.slice(0, 60) });
		}
	});
	return violations;
}

describe("帧不变量", () => {
	const widths = [20, 30, 40, 60, 80, 120, 160, 200];

	for (const width of widths) {
		it(`${width} 列：每行宽度与转义受控`, async () => {
			const violations = await inspect(width, 30);
			expect(violations).toEqual([]);
		}, 15000);
	}
});
