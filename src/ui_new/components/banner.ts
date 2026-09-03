/**
 * 首屏 Banner 启动展示（复刻 dsh-TUI 像素鲸鱼 + 腹部居中技术标语 + 5 行连贯平滑大字）。
 * 特性：
 * 1. 动态自适应列宽：基于终端宽度智能排版，严格锁定每行宽度，杜绝任何字符折行溢出破坏鲸鱼画面；
 * 2. 激光对齐：鲸鱼固定 40 宽度 + 3 间距，右侧元信息严格截断保护；
 * 3. 极窄窗口（< 72 列）自动优雅切换为紧凑居中极客排版，全平台无论如何缩放均无瑕疵。
 */

import { C, visibleWidth, truncateToWidth } from "../core/utils.js";

type Rgb = readonly [number, number, number];

const PALETTE: Record<string, Rgb | undefined> = {
	D: [20, 38, 96], // 深蓝轮廓
	B: [78, 111, 255], // DeepSeek 蓝身体
	L: [190, 225, 255], // 浅蓝腹部
	W: [255, 255, 255], // 亮白嘴部
	H: [204, 51, 153], // 粉心
	Z: [128, 128, 128], // 灰色
};

const fg = (rgb: Rgb): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const bg = (rgb: Rgb): string => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;

/** dsh-TUI 经典像素鲸鱼标准静态帧（通过半块字 ▀/▄ 合成为 13 行，每行严格 40 字符宽） */
const STANDARD_WHALE_ROWS: readonly string[] = [
	"........................................",
	"........................................",
	"........................D...............",
	".......................DBD.......D......",
	".......................DBBD.....DBD.....",
	".......................DBBBD..DDBBD.....",
	".......................DBBBBDDBBBBD.....",
	".......DDDDDDDDD........DBBBBBBBBD......",
	"......DBBBBBBBBBDD.......DBBBBBBBD......",
	".....DBBBBBBBBBBBBDD.....DBBBBBDD.......",
	"....DBBBBBBBBBBBBBBBDD....DBBBD.........",
	"...DDBBBBBBBBBBBBBBBBBD..DBBBBD.........",
	"...DBBBBBBBBBBBBBBBBBBBDDBBBBBD.........",
	"...DBBBDBBBBBBDBBBBBBBBBBBBBBBD.........",
	"...DBBBDBBBBBBDBBBBBBBBBBBBBBD..........",
	"...DBBBBBBBBBBBBBBBBBBBBBBBBBD..........",
	"...DBBBBWWWWWWWBBBBBBBBDBBBBD...........",
	"...DDBWWWWWWWWWWWWBBBBBBDBBBD...........",
	"....DLLWWWWWWWWWWWWDBBBBDDBD............",
	".....DLLLWWWWWWWWWWDBBBBBDD.............",
	"......DDLLLWWWWWWLLLDBBBBBDD............",
	"........DLLLLLLLLLLLDDBBBBBBD...........",
	".........DDDDDDDDDDD..DDDDDDD...........",
	"........................................",
	"........................................",
];

function renderWhaleLines(): string[] {
	const rows: string[] = [];
	for (let r = 0; r < STANDARD_WHALE_ROWS.length; r += 2) {
		const upper = STANDARD_WHALE_ROWS[r]!;
		const lower = STANDARD_WHALE_ROWS[r + 1] ?? "";
		let out = "";
		let current = "";
		for (let x = 0; x < upper.length; x++) {
			const up = PALETTE[upper[x]!];
			const lo = PALETTE[lower[x]!];
			let seq: string;
			let ch: string;
			if (up !== undefined && lo !== undefined) {
				seq = fg(up) + bg(lo);
				ch = "▀";
			} else if (up !== undefined) {
				seq = fg(up);
				ch = "▀";
			} else if (lo !== undefined) {
				seq = fg(lo);
				ch = "▄";
			} else {
				seq = "";
				ch = " ";
			}
			if (seq !== current) {
				out += seq === "" ? C.reset : seq;
				current = seq;
			}
			out += ch;
		}
		if (!out.endsWith(C.reset)) out += C.reset;
		rows.push(out);
	}
	return rows;
}

/** 5 行平滑紧凑 Block Font 大字：UINA（严格对齐 dsh-TUI 5x5 圆角字规范，宽 26 列） */
const BIGFONT_UINA: readonly [string, string, string, string, string] = [
	"█···█  ▀▀█▀▀  █···█  ·▄▀▄·",
	"█···█  ··█··  ██··█  █···█",
	"█···█  ··█··  █·█·█  █▀▀▀█",
	"█···█  ··█··  █··██  █···█",
	"█▄▄▄█  ▄▄█▄▄  █···█  █···█",
];

function renderBigfontUina(): string[] {
	const ice = [147, 190, 255] as const;
	const brand = [78, 111, 255] as const;
	return BIGFONT_UINA.map((rawLine, r) => {
		const factor = r / 4;
		const red = Math.round(ice[0] + (brand[0] - ice[0]) * factor);
		const green = Math.round(ice[1] + (brand[1] - ice[1]) * factor);
		const blue = Math.round(ice[2] + (brand[2] - ice[2]) * factor);
		const color = `\x1b[38;2;${red};${green};${blue}m\x1b[1m`;
		return `${color}${rawLine.replace(/·/g, " ")}${C.reset}`;
	});
}

export interface BannerOptions {
	modelName?: string;
	toolCount?: number;
	cwd?: string;
}

/** 生成完整的首屏启动 Banner 行数组（支持自适应终端宽度） */
export function getStartupBanner(
	options?: BannerOptions,
	terminalWidth = 80,
): string[] {
	const width = Math.max(24, terminalWidth);
	const banner: string[] = [""]; // 顶部空行留白

	const uinaLines = renderBigfontUina();
	const model = options?.modelName ?? "deepseek-chat";
	const tools = options?.toolCount ?? 6;

	// 阈值判定：宽度 >= 72 列时并排展示 40 列像素鲸鱼与右侧信息；小于 72 列时展示专为窄屏设计的居中极客横幅
	if (width >= 72) {
		const whaleLines = renderWhaleLines();
		const availRight = Math.max(10, width - 43); // 40鲸鱼 + 3空格间距

		// 动态适配右侧信息，严格截断，物理阻止超出 availRight
		const info1 = truncateToWidth(
			`${C.bold}${C.white}Uina${C.reset} · ${C.iceBlue}Autonomous Agent Core${C.reset}`,
			availRight,
			"",
		);
		const info2 = truncateToWidth(
			availRight >= 36
				? `${C.gray}模型: ${C.green}${model}${C.gray}  工具: ${C.green}${tools}${C.gray} 个已就绪${C.reset}`
				: `${C.gray}${model} · ${tools} tools${C.reset}`,
			availRight,
			"",
		);

		const cwd = options?.cwd ?? process.cwd();
		const infoCwd = truncateToWidth(
			`${C.gray}目录: ${C.cyan}${cwd}${C.reset}`,
			availRight,
			"",
		);

		// info3（操作快捷键指引）：在宽屏下完整显示，在中等屏幕精简，窄屏优雅省略
		let rawInfo3 = "";
		if (availRight >= 56) {
			rawInfo3 = `${C.dim}支持自然语言对话 | /stop 中断 | !cmd 终端执行 | /quit 退出${C.reset}`;
		} else if (availRight >= 38) {
			rawInfo3 = `${C.dim}/stop 中断 | !cmd 执行 | /quit 退出${C.reset}`;
		} else if (availRight >= 20) {
			rawInfo3 = `${C.dim}/stop 中断 | /quit 退出${C.reset}`;
		}
		const info3 = truncateToWidth(rawInfo3, availRight, "");

		for (let i = 0; i < whaleLines.length; i++) {
			const whalePart = whaleLines[i]!;
			let rightPart = "";
			if (i === 1) rightPart = `   ${truncateToWidth(uinaLines[0]!, availRight, "")}`;
			else if (i === 2) rightPart = `   ${truncateToWidth(uinaLines[1]!, availRight, "")}`;
			else if (i === 3) rightPart = `   ${truncateToWidth(uinaLines[2]!, availRight, "")}`;
			else if (i === 4) rightPart = `   ${truncateToWidth(uinaLines[3]!, availRight, "")}`;
			else if (i === 5) rightPart = `   ${truncateToWidth(uinaLines[4]!, availRight, "")}`;
			else if (i === 7 && info1) rightPart = `   ${info1}`;
			else if (i === 8 && info2) rightPart = `   ${info2}`;
			else if (i === 9 && infoCwd) rightPart = `   ${infoCwd}`;
			else if (i === 10 && info3) rightPart = `   ${info3}`;

			banner.push(`${whalePart}${rightPart}`);
		}

		// 鲸鱼腹部正下方（40 列居中）：技术极客锚点标语
		const tagline = "✦ Autonomous Runtime · Latency < 1.8s ✦";
		const tagWidth = visibleWidth(tagline);
		const leadPad = Math.max(0, Math.floor((38 - tagWidth) / 2));
		const centeredTagline = `${" ".repeat(leadPad)}${C.iceBlue}${C.dim}${tagline}${C.reset}`;
		banner.push(centeredTagline);
	} else {
		// 专为窄屏 / 分屏设计的紧凑居中极客模式（终端列宽 < 72，如 40~60 列）
		if (width >= 30) {
			for (const line of uinaLines) {
				const lineW = visibleWidth(line);
				const pad = Math.max(0, Math.floor((width - lineW) / 2));
				banner.push(`${" ".repeat(pad)}${line}`);
			}
			banner.push("");
		} else {
			const compactTitle = `${C.bold}${C.cyan}✦ UINA AGENT ✦${C.reset}`;
			const pad = Math.max(0, Math.floor((width - visibleWidth(compactTitle)) / 2));
			banner.push(`${" ".repeat(pad)}${compactTitle}`);
		}

		const info1 = width >= 34
			? `${C.bold}${C.white}Uina${C.reset} · ${C.iceBlue}Autonomous Agent Core${C.reset}`
			: `${C.bold}${C.white}Uina Agent Core${C.reset}`;
		const pad1 = Math.max(0, Math.floor((width - visibleWidth(info1)) / 2));
		banner.push(`${" ".repeat(pad1)}${truncateToWidth(info1, width, "")}`);

		const info2 = width >= 34
			? `${C.gray}${model} · ${tools} tools ready${C.reset}`
			: `${C.gray}${model}${C.reset}`;
		const pad2 = Math.max(0, Math.floor((width - visibleWidth(info2)) / 2));
		banner.push(`${" ".repeat(pad2)}${truncateToWidth(info2, width, "")}`);

		const cwd = options?.cwd ?? process.cwd();
		const normPath = cwd.replace(/\\/g, "/");
		const baseCwd = normPath.split("/").filter(Boolean).pop() || cwd;
		const infoCwd = width >= 40
			? `${C.gray}目录: ${C.cyan}${cwd}${C.reset}`
			: `${C.gray}📁 ${baseCwd}${C.reset}`;
		const padCwd = Math.max(0, Math.floor((width - visibleWidth(infoCwd)) / 2));
		banner.push(`${" ".repeat(padCwd)}${truncateToWidth(infoCwd, width, "")}`);

		const tagline = width >= 42
			? `${C.iceBlue}${C.dim}✦ Autonomous Runtime · Latency < 1.8s ✦${C.reset}`
			: `${C.iceBlue}${C.dim}✦ Latency < 1.8s ✦${C.reset}`;
		const padTag = Math.max(0, Math.floor((width - visibleWidth(tagline)) / 2));
		banner.push(`${" ".repeat(padTag)}${truncateToWidth(tagline, width, "")}`);
	}

	banner.push(""); // 底部留白一行
	return banner;
}
