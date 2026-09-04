/**
 * 工具调用状态与结果卡片组件（全面对齐 dsh-TUI 极简树状折线风格，零边距左对齐）。
 * 特性：
 * 1. 运行中显示轻量单行呼吸状态：“• ⏳ [工具名] [参数] · 执行中...”；
 * 2. 完成后以轻量树状折线展开：“• [工具名] · [耗时]”+“  └exitCode: 0”+“   stdout: ...”；
 * 3. 失败时清晰标红并引导快捷键查看轨迹；
 * 4. 彻底消除前导多余空格，完全左对齐。
 */

import { C, truncateToWidth } from "../../core/utils.js";

export function formatToolCardLines(
	name: string,
	result: string,
	elapsedMs: number,
	width = 80,
	status: "running" | "completed" | "failed" = "completed",
	args?: unknown,
): string[] {
	const maxW = Math.max(20, width);

	if (status === "running") {
		let argStr = "";
		try {
			argStr = JSON.stringify(args ?? {});
		} catch {
			argStr = String(args);
		}
		if (argStr === "{}") argStr = "";
		const shortArg = argStr.length > 40 ? `${argStr.slice(0, 37)}…` : argStr;
		const line = `${C.yellow}⏳ ${C.bold}${name}${C.reset}${shortArg ? ` ${C.dim}${shortArg}${C.reset}` : ""} · ${C.yellow}执行中...${C.reset}`;
		return [truncateToWidth(`  ${line}`, maxW, "…"), ""];
	}

	const t = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;

	let obj: Record<string, unknown> | null = null;
	try {
		obj = JSON.parse(result) as Record<string, unknown>;
	} catch {
		obj = null;
	}

	const lines: string[] = [];

	if (obj && typeof obj === "object") {
		if (obj.cancelled) {
			lines.push(`${C.yellow}⚠ ${name}${C.reset} · ${C.dim}${t}${C.reset}`);
			lines.push(`  ${C.dim}└${C.yellow}操作已取消${C.reset}`);
			lines.push("");
			return lines;
		}

		const errText = typeof obj.error === "string" ? obj.error.replace(/\r/g, "").trim() : "";
		if (errText) {
			lines.push(`${C.red}✗ ${C.bold}${name}${C.reset} · ${C.dim}${t}${C.reset}`);
			lines.push(`  ${C.dim}└${C.red}${truncateToWidth(errText, maxW - 4, "…")}${C.reset}`);
			lines.push(`   ${C.dim}Alt+T 查看轨迹${C.reset}`);
			lines.push("");
			return lines;
		}

		// 正常执行完成，树状展示
		lines.push(`${C.iceBlue}• ${C.bold}${name}${C.reset} · ${C.dim}${t}${C.reset}`);
		const exitCode = typeof obj.code === "number" ? obj.code : 0;
		lines.push(`  ${C.dim}└exitCode: ${exitCode}${C.reset}`);

		const stdout = typeof obj.stdout === "string" ? obj.stdout.replace(/\r/g, "").trim() : "";
		const stderr = typeof obj.stderr === "string" ? obj.stderr.replace(/\r/g, "").trim() : "";

		if (stdout) {
			const outLines = stdout.split("\n").map((s) => s.trimEnd()).filter(Boolean);
			if (outLines.length > 0) {
				lines.push(`   ${C.dim}stdout:${C.reset} ${truncateToWidth(outLines[0]!, maxW - 12, "…")}`);
				for (const extra of outLines.slice(1, 6)) {
					lines.push(`           ${truncateToWidth(extra, maxW - 12, "…")}`);
				}
				if (outLines.length > 6) {
					lines.push(`           ${C.dim}… +${outLines.length - 6} lines${C.reset}`);
				}
			}
		}

		if (stderr) {
			const errLines = stderr.split("\n").map((s) => s.trimEnd()).filter(Boolean);
			if (errLines.length > 0) {
				lines.push(`   ${C.red}stderr:${C.reset} ${truncateToWidth(errLines[0]!, maxW - 12, "…")}`);
				for (const extra of errLines.slice(1, 4)) {
					lines.push(`           ${C.red}${truncateToWidth(extra, maxW - 12, "…")}${C.reset}`);
				}
			}
		}

		if (!stdout && !stderr) {
			const keys = Object.keys(obj)
				.filter((k) => k !== "code" && k !== "elapsedMs" && k !== "status")
				.slice(0, 3)
				.map((k) => `${k}: ${String(obj![k]).replace(/\r/g, "").slice(0, 30)}`)
				.join(", ");
			if (keys) {
				lines.push(`   ${C.dim}${truncateToWidth(keys, maxW - 4, "…")}${C.reset}`);
			} else {
				lines.push(`   ${C.dim}(执行完成，无输出)${C.reset}`);
			}
		}
	} else {
		lines.push(`${C.iceBlue}• ${C.bold}${name}${C.reset} · ${C.dim}${t}${C.reset}`);
		const raw = String(result).replace(/\r/g, "").trim();
		if (raw) {
			const rawLines = raw.split("\n").map((s) => s.trimEnd()).filter(Boolean);
			lines.push(`  ${C.dim}└${C.reset}${truncateToWidth(rawLines[0]!, maxW - 4, "…")}`);
			for (const extra of rawLines.slice(1, 6)) {
				lines.push(`   ${truncateToWidth(extra, maxW - 4, "…")}`);
			}
			if (rawLines.length > 6) {
				lines.push(`   ${C.dim}… +${rawLines.length - 6} lines${C.reset}`);
			}
		} else {
			lines.push(`  ${C.dim}└(执行完成，无输出)${C.reset}`);
		}
	}

	lines.push("");
	return lines;
}
