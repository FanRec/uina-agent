/**
 * 逐格终端模型（VtScreen）：把终端输出喂进来，得到"屏幕上一格一格到底是什么"。
 *
 * 为什么需要它：帧渲染的正确性不能靠"读帧字符串"来判断 —— 帧只描述我们**写了什么**，
 * 而屏幕取决于终端**怎么解释**它。真正决定像素的语义有三条，必须在模型里如实实现：
 *
 *   1. SGR 必须优先于通用 CSI 解析（`\x1b[0m`/`\x1b[49m` 是 SGR，不是普通 CSI）；
 *   2. EL（`\x1b[K`）用**当时仍生效的背景色**涂满光标到行尾 —— 这是"最后一格颜色
 *      由谁决定"的关键，也是"高亮缺一格"这类缺陷唯一能复现的地方；
 *   3. HT 只把光标移到下一个 8 列制表位，**不涂色**被跳过的格子；CR 只归位不涂色。
 *
 * 私有模式 CSI（`\x1b[?25l`、`\x1b[?2026h`…）是 no-op：旧模型把它们当可打印文本，
 * 会在模拟屏里写字符、甚至触发一次滚动，于是测试成败由模型伪影决定。
 *
 * 宽度口径：与 src 共用 `graphemeWidth`（本模型只负责"终端语义"，不重复实现 Unicode 宽度）。
 * "模型宽度 vs 真机单元宽度"的分歧属真机范畴，不在本模型内断言。
 */
import { graphemeSegmenter, graphemeWidth } from "../../../src/ui/core/utils.js";

export interface VtCell {
	ch: string;
	fg: string;
	bg: string;
	/** 被我们写过的格子（含被 EL 涂过的格子由 `erased` 标记区分） */
	touched: boolean;
	/** 由 EL/ED 擦出来的格子：颜色被涂了，但没有内容 */
	erased: boolean;
	/** 宽字符的第二格 */
	cont: boolean;
}

export interface Run {
	row: number;
	start: number;
	end: number;
}

export class VtScreen {
	readonly grid: VtCell[][];
	row = 0;
	col = 0;
	fg = "default";
	bg = "default";
	/** 帧内发生过的滚动/折行次数：>0 说明帧高或行宽与终端不符 */
	scrolled = 0;
	wrapped = 0;
	/** 未涂色的制表位跳格总数与行内回车次数（两者都会留下"没人涂过"的格子） */
	tabJumps = 0;
	crMoves = 0;
	/** 出现过的私有模式 CSI（只记录，不解释） */
	privateModes = new Set<string>();

	constructor(readonly cols: number, readonly rows: number) {
		this.grid = Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => ({ ch: " ", fg: "default", bg: "default", touched: false, erased: false, cont: false })),
		);
	}

	private cell(r: number, c: number): VtCell {
		return this.grid[r]![c]!;
	}

	private put(ch: string, wide: boolean): void {
		if (this.col >= this.cols) {
			this.row++;
			this.col = 0;
			this.wrapped++;
		}
		if (this.row >= this.rows) this.scroll();
		const cell = this.cell(this.row, this.col);
		cell.ch = ch;
		cell.fg = this.fg;
		cell.bg = this.bg;
		cell.touched = true;
		cell.erased = false;
		cell.cont = false;
		if (wide && this.col + 1 < this.cols) {
			const next = this.cell(this.row, this.col + 1);
			next.ch = "";
			next.fg = this.fg;
			next.bg = this.bg;
			next.touched = true;
			next.erased = false;
			next.cont = true;
		}
		this.col += wide ? 2 : 1;
	}

	private scroll(): void {
		this.grid.shift();
		this.grid.push(
			Array.from({ length: this.cols }, () => ({ ch: " ", fg: "default", bg: "default", touched: false, erased: false, cont: false })),
		);
		this.row = this.rows - 1;
		this.scrolled++;
	}

	feed(data: string): void {
		let i = 0;
		while (i < data.length) {
			const rest = data.slice(i);

			// 1) SGR 必须先进：`\x1b[0m` 也匹配通用 CSI 的形状，顺序错了底色就永不复位。
			const sgr = rest.match(/^\x1b\[([0-9;]*)m/);
			if (sgr) {
				this.applySgr(sgr[1]!);
				i += sgr[0].length;
				continue;
			}

			// 2) 通用 CSI（含私有模式）
			const csi = rest.match(/^\x1b\[([?<>=]?)([0-9;]*)([A-Za-z@~])/);
			if (csi) {
				const priv = csi[1]!;
				const fn = csi[3]!;
				const params = csi[2]!.split(";").map((n) => (n ? parseInt(n, 10) : 0));
				if (priv) {
					this.privateModes.add(`CSI ${priv}${csi[2]}${fn}`);
				} else if (fn === "H" || fn === "f") {
					this.row = Math.min(this.rows - 1, Math.max(0, (params[0] || 1) - 1));
					this.col = Math.min(this.cols, Math.max(0, (params[1] || 1) - 1));
				} else if (fn === "K") {
					// EL：用当前底色涂满光标到行尾（不产生内容，故标 erased）
					const mode = params[0] ?? 0;
					const from = mode === 1 ? 0 : this.col;
					const to = mode === 1 ? this.col : this.cols - 1;
					for (let x = from; x <= to && x < this.cols; x++) {
						const cell = this.cell(this.row, x);
						cell.ch = " ";
						cell.fg = this.fg;
						cell.bg = this.bg;
						cell.erased = true;
						cell.cont = false;
					}
				} else if (fn === "J") {
					for (let r = 0; r < this.rows; r++) {
						for (let c = 0; c < this.cols; c++) {
							const cell = this.cell(r, c);
							cell.ch = " ";
							cell.fg = "default";
							cell.bg = "default";
							cell.touched = false;
							cell.erased = false;
							cell.cont = false;
						}
					}
				}
				i += csi[0].length;
				continue;
			}

			// 3) OSC / APC / 单字符 ESC
			const osc = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
			if (osc) {
				i += osc[0].length;
				continue;
			}
			const esc = rest.match(/^\x1b[@-Z\\-_]/);
			if (esc) {
				i += esc[0].length;
				continue;
			}

			// 4) 控制字符
			const ch = data[i]!;
			if (ch === "\t") {
				const next = (Math.floor(this.col / 8) + 1) * 8;
				this.tabJumps += next - Math.min(this.col, this.cols);
				this.col = Math.min(this.cols, next);
				i++;
				continue;
			}
			if (ch === "\r") {
				this.crMoves++;
				this.col = 0;
				i++;
				continue;
			}
			if (ch === "\n") {
				this.row++;
				if (this.row >= this.rows) this.scroll();
				i++;
				continue;
			}
			if (ch < " " || ch === "\x7f") {
				i++;
				continue;
			}

			// 5) 可见字符：按 grapheme 簇推进（宽度口径与 src 一致）
			const seg = graphemeSegmenter.segment(data.slice(i))[Symbol.iterator]().next();
			const piece = seg.done ? ch : (seg.value as { segment: string }).segment;
			this.put(piece, graphemeWidth(piece) >= 2);
			i += piece.length;
		}
	}

	private applySgr(body: string): void {
		const codes = body.split(";").map((n) => (n ? parseInt(n, 10) : 0));
		for (let k = 0; k < codes.length; k++) {
			const code = codes[k]!;
			if (code === 0) {
				this.fg = "default";
				this.bg = "default";
			} else if (code === 39) {
				this.fg = "default";
			} else if (code === 49) {
				this.bg = "default";
			} else if (code === 48 && codes[k + 1] === 2) {
				this.bg = `${codes[k + 2]},${codes[k + 3]},${codes[k + 4]}`;
				k += 4;
			} else if (code === 38 && codes[k + 1] === 2) {
				this.fg = `${codes[k + 2]},${codes[k + 3]},${codes[k + 4]}`;
				k += 4;
			} else if (code === 48 && codes[k + 1] === 5) {
				this.bg = `idx:${codes[k + 2]}`;
				k += 2;
			} else if (code === 38 && codes[k + 1] === 5) {
				this.fg = `idx:${codes[k + 2]}`;
				k += 2;
			}
		}
	}

	/** 每行可见文本（去掉宽字符续格与行尾空白） */
	lines(): string[] {
		return this.grid.map((r) => r.map((c) => (c.cont ? "" : c.ch)).join("").replace(/\s+$/, ""));
	}

	rowText(r: number): string {
		return this.lines()[r] ?? "";
	}

	/**
	 * 完全没被涂过的格子（真机上会保留上一帧内容：就是"内容重叠 / 底色缺格"）。
	 * 注意区分：被 EL 擦出来的格子算"涂过"（底色已被我们声明），只是没有内容。
	 */
	unpaintedRuns(minRun = 1): Run[] {
		const out: Run[] = [];
		for (let r = 0; r < this.rows; r++) {
			let start = -1;
			for (let c = 0; c <= this.cols; c++) {
				const idle = c < this.cols && !this.grid[r]![c]!.touched && !this.grid[r]![c]!.erased;
				if (idle) {
					if (start === -1) start = c;
				} else if (start !== -1) {
					if (c - start >= minRun) out.push({ row: r, start, end: c - 1 });
					start = -1;
				}
			}
		}
		return out;
	}

	/** 只被 EL 擦过、没有内容的格子（底色由当时的 SGR 决定，必须等于行声明） */
	erasedOnlyRuns(): Run[] {
		const out: Run[] = [];
		for (let r = 0; r < this.rows; r++) {
			let start = -1;
			for (let c = 0; c <= this.cols; c++) {
				const erased = c < this.cols && this.grid[r]![c]!.erased && !this.grid[r]![c]!.touched;
				if (erased) {
					if (start === -1) start = c;
				} else if (start !== -1) {
					if (c - start >= 1) out.push({ row: r, start, end: c - 1 });
					start = -1;
				}
			}
		}
		return out;
	}

	/** 该行第一格的底色（用于检查行首是否复位了 SGR 状态） */
	firstBg(r: number): string {
		return this.grid[r]?.[0]?.bg ?? "default";
	}

	/** 指定底色的行集合（用于判定"高亮带覆盖了哪些行"） */
	rowsWithBg(bg: string): number[] {
		const out: number[] = [];
		for (let r = 0; r < this.rows; r++) {
			if (this.grid[r]!.some((c) => c.bg === bg)) out.push(r);
		}
		return out;
	}

	/** 某行里指定底色的列区间（用于找"带子里的缺口"） */
	bgRuns(r: number, bg: string): Run[] {
		const out: Run[] = [];
		let start = -1;
		for (let c = 0; c <= this.cols; c++) {
			const hit = c < this.cols && this.grid[r]![c]!.bg === bg;
			if (hit) {
				if (start === -1) start = c;
			} else if (start !== -1) {
				out.push({ row: r, start, end: c - 1 });
				start = -1;
			}
		}
		return out;
	}

	/** 某行里"含该底色，但中间被非该底色切断"的缺口（>=1 格） */
	holesInBand(bg: string): Run[] {
		const out: Run[] = [];
		for (let r = 0; r < this.rows; r++) {
			const runs = this.bgRuns(r, bg);
			if (runs.length < 2) continue;
			for (let i = 1; i < runs.length; i++) {
				out.push({ row: r, start: runs[i - 1]!.end + 1, end: runs[i]!.start - 1 });
			}
		}
		return out;
	}

	/** 该行最后一格的实际底色 */
	tailBg(r: number): string {
		return this.grid[r]?.[this.cols - 1]?.bg ?? "default";
	}

	/** 该行每一格的底色（供"声明即事实"逐格比对） */
	rowBgs(r: number): string[] {
		return (this.grid[r] ?? []).map((c) => c.bg);
	}

	/** 获取当前屏幕栅格的纯文本表达（逐行拼接，自动去除行尾空白） */
	getVisibleText(): string {
		return this.grid
			.map((row) => row.map((c) => c.ch).join("").trimEnd())
			.join("\n")
			.trimEnd();
	}
}
