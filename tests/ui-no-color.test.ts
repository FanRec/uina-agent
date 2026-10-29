/**
 * W7 终端颜色能力：NO_COLOR / TERM=dumb 下输出零 SGR，帧结构不塌。
 * 子进程脚本从 tmp 独立文件加载，避免引号与换行转义问题。
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function renderFrameWithEnv(env: Record<string, string | undefined>): string {
	const script = join(ROOT, "tmp", "nocolor-probe.mjs");
	writeFileSync(
		script,
		[
			"import { UIHost } from '../src/ui/ui-host.js';",
			"import { createSilentTerminal } from '../tests/harness/environment/silent-terminal.js';",
			"const { terminal, frames } = createSilentTerminal(80, 24);",
			"const host = new UIHost({ terminal });",
			"host.start();",
			"host.transcript.startTurn(1, '用户提问');",
			"host.transcript.appendToken('第一段回复，包含中文与 ASCII。');",
			"host.requestRender();",
			"await new Promise((resolve) => setTimeout(resolve, 120));",
			"process.stdout.write(JSON.stringify(frames.at(-1) ?? ''));",
			"host.stop();",
		].join("\n"),
	);
	try {
		return execFileSync(process.execPath, ["--import", "tsx", script], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} finally {
		try {
			execFileSync("node", ["-e", "require('node:fs').unlinkSync(" + JSON.stringify(script) + ")"], { cwd: ROOT });
		} catch {
			// 清理失败不影响断言
		}
	}
}

describe("NO_COLOR / TERM=dumb（W7 第 9 项）", () => {
	it("默认环境有 SGR；NO_COLOR=1 与 TERM=dumb 输出零 SGR", () => {
		const normal = JSON.parse(renderFrameWithEnv({})) as string;
		expect(normal).toMatch(/\x1b\[[0-9;]*m/);

		// 着色 SGR 的判定式：前景/背景/属性一律不得出现。
		// 纯 reset（\x1b[0m）允许残留——它在未着色的输出上是 no-op 协议字节，
		// 与 no-color.org 的“不产生彩色输出”语义一致（W7 记录的有意取舍）。
		const COLOR_SGR = /\x1b\[(?:[0-9]*;?)*(?:3[0-9]|4[0-9]|9[0-7]|1|2|3|4|7|9)m/;

		for (const env of [{ NO_COLOR: "1" }, { TERM: "dumb" }, { NO_COLOR: "", TERM: "dumb" }]) {
			const frame = JSON.parse(renderFrameWithEnv(env)) as string;
			expect(frame, JSON.stringify(env)).not.toMatch(COLOR_SGR);
			// 帧结构不塌：仍包含正文与横幅关键内容
			expect(frame).toContain("第一段回复");
			expect(frame).toContain("Uina");
		}
	}, 60000);
});
