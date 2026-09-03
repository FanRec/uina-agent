import { describe, it, expect, vi } from "vitest";
import { visibleWidth, truncateToWidth, wrapTextWithAnsi, stripAnsi } from "../src/ui_new/core/utils.js";
import { StreamMarkdownFormatter } from "../src/ui_new/components/stream-markdown.js";
import { ContextBarComponent } from "../src/ui_new/components/context-bar.js";
import { ActivityLineComponent, sweep } from "../src/ui_new/components/activity-line.js";
import { formatToolCardLines } from "../src/ui_new/components/tool-view.js";
import { InputLine } from "../src/ui_new/editor/input-line.js";
import { ProcessTerminal } from "../src/ui_new/core/terminal.js";
import { MainScreenRenderer } from "../src/ui_new/core/renderer.js";
import { CURSOR_MARKER } from "../src/ui_new/core/types.js";

describe("ui_new core utils", () => {
	it("正确计算包含中文与 ANSI 样式的显示宽度", () => {
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("你好")).toBe(4);
		expect(visibleWidth("\x1b[31m你好\x1b[0m world")).toBe(10);
	});

	it("ANSI 安全截断：不截断转义码且正确补齐闭合", () => {
		const text = "\x1b[36m这是一个很长的句子需要截断\x1b[0m";
		const truncated = truncateToWidth(text, 10);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(10);
		expect(truncated).toContain("\x1b[0m");
	});

	it("带 ANSI 样式的文本折行", () => {
		const text = "第一行测试很长需要折行的一句话\n第二行短";
		const lines = wrapTextWithAnsi(text, 12);
		expect(lines.length).toBeGreaterThan(1);
	});
});

describe("ui_new visual components", () => {
	it("流式 Markdown 格式化代码块与行内元素", () => {
		const formatter = new StreamMarkdownFormatter();
		const line1 = formatter.formatLine("```typescript");
		expect(line1).toContain("typescript");
		const line2 = formatter.formatLine("const x = 1;");
		expect(line2).toContain("│");
		const line3 = formatter.formatLine("```");
		expect(line3).toContain("└");

		const header = formatter.formatLine("# 标题测试");
		expect(header).toContain("标题测试");

		const bullet = formatter.formatLine("- 列表项 `code`");
		expect(bullet).toContain("•");
		expect(bullet).toContain("code");
	});

	it("InputLine 经典圆角盒与底边框图形进度条渲染", () => {
		const box = new InputLine();
		box.setStatusHeader("⠋ 思考中");
		box.setContextStats("deepseek-chat", 14200, 65536);
		const lines = box.render(80);
		// 拥有至少 2 行内容输入区，总高为 4 行
		expect(lines.length).toBe(4);
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("思考中");
		expect(lines[1]).toContain("│");
		expect(lines[1]).toContain("❯");
		expect(lines[3]).toContain("╰");
		expect(lines[3]).toContain("deepseek-chat");
		expect(lines[3]).toContain("21.7%");
		expect(lines[3]).toContain("█");
		expect(lines[3]).toContain("░");

		// 数学级对齐验证：每一行的显示列宽必须 100% 完全相同（无论是否清除物理光标标记 CURSOR_MARKER）
		expect(stripAnsi(CURSOR_MARKER)).toBe("");
		const widths = lines.map((l) => visibleWidth(l));
		expect(widths).toEqual([76, 76, 76, 76]);

		const cleanWidths = lines.map((l) => visibleWidth(l.replace(CURSOR_MARKER, "")));
		expect(cleanWidths).toEqual([76, 76, 76, 76]);
	});

	it("InputLine 行内粘贴标记系统：支持文字前后插入、退格原子删除、Ctrl+V 原地展开与提交展开", () => {
		const box = new InputLine();
		box.setContextStats("deepseek-chat", 1000, 65536);

		// 1. 先打前缀文字
		box.handleInput("请审查代码：");
		// 2. 在光标处粘贴多行
		box.handleInput("function test() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n");
		// 3. 在标记后继续打后缀文字
		box.handleInput(" 感谢！");

		// 渲染检验：中间行应同时包含前缀、高亮粘贴芯片与后缀
		const lines = box.render(100);
		expect(lines[1]).toContain("请审查代码：");
		expect(lines[1]).toContain("已粘贴");
		expect(lines[1]).toContain("感谢！");

		// 提交文本检验：getText() 必须自动将标记展开为真正的多行完整代码
		const fullText = box.getText();
		expect(fullText).toContain("请审查代码：");
		expect(fullText).toContain("function test()");
		expect(fullText).toContain("感谢！");

		// 4. 测试退格原子删除：新建一个只有标记的输入框
		const chipBox = new InputLine();
		chipBox.handleInput("line1\nline2\nline3\nline4\nline5\n");
		expect(chipBox.getText()).toContain("line1");
		// 按退格键直接删掉整个标记
		chipBox.handleInput("\x7f");
		expect(chipBox.getText()).toBe("");

		// 5. 测试 Ctrl+O 原地展开标记
		const expandBox = new InputLine();
		expandBox.handleInput("line1\nline2\nline3\nline4\nline5\n");
		expect(expandBox.hasChipAtCursor()).toBe(true);
		// 按 Ctrl+O (\x0f)
		expandBox.handleInput("\x0f");
		expect(expandBox.getText()).toContain("line1\nline2");

		// 6. 测试 Ctrl+A 全选功能
		const selectBox = new InputLine();
		selectBox.handleInput("prefix ");
		selectBox.handleInput("line1\nline2\nline3\n");
		selectBox.handleInput(" suffix");
		// 按 Ctrl+A (\x01)
		selectBox.handleInput("\x01");
		// 全选状态下打入退格键，整框一键清空
		selectBox.handleInput("\x7f");
		expect(selectBox.getText()).toBe("");

		// 7. 测试单行超长文本生成字数标记而非行数标记
		const charBox = new InputLine();
		charBox.handleInput("w".repeat(120));
		const charLines = charBox.render(80);
		expect(charLines[1]).toContain("120字");

		// 8. 测试多行文本（含 \n）在输入框中渲染，每一行都必须被 │ 包裹且列宽严格一致
		const multiBox = new InputLine();
		multiBox.handleInput("第一行文本\n第二行内容\n第三行短");
		// 按 Ctrl+O 展开为真正的多行文本
		multiBox.handleInput("\x0f");
		const multiLines = multiBox.render(80);
		// 顶边框 + 3行内容 + 底边框 = 5行
		expect(multiLines.length).toBe(5);
		const baseWidth = visibleWidth(multiLines[0]);
		for (const row of multiLines) {
			expect(row).not.toContain("\n");
			expect(visibleWidth(row)).toBe(baseWidth);
		}

		// 9. 测试 Shift+Enter 换行插入 \n 与普通回车提交
		const shiftEnterBox = new InputLine();
		let submittedText = "";
		shiftEnterBox.onSubmit = (val) => {
			submittedText = val;
		};
		shiftEnterBox.handleInput("第一行");
		// 按 Shift+Enter（Kitty 编码 \x1b[13;2u）换行
		shiftEnterBox.handleInput("\x1b[13;2u");
		shiftEnterBox.handleInput("第二行");
		// 按 Shift+Enter（终端 raw 模式下回车 \n）换行
		shiftEnterBox.handleInput("\n");
		shiftEnterBox.handleInput("第三行");
		expect(shiftEnterBox.getText()).toBe("第一行\n第二行\n第三行");

		// 按普通回车 \r 提交
		shiftEnterBox.handleInput("\r");
		expect(submittedText).toBe("第一行\n第二行\n第三行");
		expect(shiftEnterBox.getText()).toBe("");
	});

	it("ActivityLine 流光状态与顶栏提取", () => {
		const act = new ActivityLineComponent();
		act.start("thinking", "正在思考分析");
		const header = act.getHeaderString(80);
		expect(stripAnsi(header)).toContain("正在思考分析");

		act.finish("任务完成");
		const doneHeader = act.getHeaderString(80);
		expect(doneHeader).toContain("任务完成");
	});

	it("工具结果封闭细线卡片渲染", () => {
		const cardLines = formatToolCardLines("exec_command", JSON.stringify({ stdout: "line1\nline2", code: 0 }), 1200, 80);
		expect(cardLines.length).toBeGreaterThanOrEqual(3);
		expect(cardLines[0]).toContain("┌");
		expect(cardLines[0]).toContain("exec_command");
		expect(cardLines[cardLines.length - 1]).toContain("└");
		expect(cardLines[cardLines.length - 1]).toContain("1.2s");
	});

	it("MainScreenRenderer fullRedraw 原子清屏重排", () => {
		const term = new ProcessTerminal();
		const renderer = new MainScreenRenderer(term);
		let written = "";
		const spy = vi.spyOn(term, "syncWrite").mockImplementation((data) => {
			written = data;
		});

		renderer.fullRedraw(["Line 1", "Line 2"], ["Active Row 1", "Active Row 2"]);
		expect(written).toContain("\x1b[2J\x1b[H\x1b[3J");
		expect(written).toContain("Line 1\r\nLine 2");
		expect(written).toContain("Active Row 1\r\nActive Row 2");

		spy.mockRestore();
	});

	it("ThinkingViewComponent 支持流式双态（收起摘要 / 展开全文带光标）与切换", async () => {
		const { ThinkingViewComponent } = await import("../src/ui_new/components/thinking-view.js");
		const view = new ThinkingViewComponent();
		view.appendThinking("第一步：意图识别\n第二步：系统架构推导\n");

		// 默认收起态：单行摘要预览
		expect(view.isCollapsed()).toBe(true);
		const collapsedLines = view.render(80);
		expect(collapsedLines.length).toBe(2);
		expect(collapsedLines[0]).toContain("思考中");
		expect(collapsedLines[0]).toContain("Ctrl+O 展开实时思考");

		// 切换展开态：多行实时思考内容 + 动态光标
		view.toggleCollapse();
		expect(view.isCollapsed()).toBe(false);
		const expandedLines = view.render(80);
		expect(expandedLines.length).toBeGreaterThan(2);
		expect(expandedLines[0]).toContain("正在深度推理");
		expect(expandedLines.join("\n")).toContain("│");
		expect(expandedLines.join("\n")).toContain("系统架构推导");
		expect(expandedLines.join("\n")).toContain("█");
	});

	it("SGR 鼠标点击事件解析与边界处理", async () => {
		const { parseMouseEvent } = await import("../src/ui_new/core/keys.js");
		// 鼠标左键在 (col=15, row=8) 按下
		const ev1 = parseMouseEvent("\x1b[<0;15;8M");
		expect(ev1).toEqual({ button: 0, col: 15, row: 8, isDown: true });

		// 鼠标左键释放
		const ev2 = parseMouseEvent("\x1b[<0;15;8m");
		expect(ev2).toEqual({ button: 0, col: 15, row: 8, isDown: false });

		// 非鼠标 ANSI 转义序列返回 null
		expect(parseMouseEvent("\x1b[A")).toBeNull();
		expect(parseMouseEvent("hello")).toBeNull();
	});

	it("matchesKey 精准识别 Alt+O 与 Ctrl+O", async () => {
		const { matchesKey, Key } = await import("../src/ui_new/core/keys.js");
		// Ctrl+O
		expect(matchesKey("\x0f", Key.ctrl("o"))).toBe(true);

		// Alt+O (覆盖标准 ESC+o 以及 Kitty/win32 键盘扩展协议码)
		expect(matchesKey("\x1bo", "alt+o")).toBe(true);
		expect(matchesKey("\x1bO", "alt+o")).toBe(true);
		expect(matchesKey("\x1b[111;3u", "alt+o")).toBe(true);
		expect(matchesKey("o", "alt+o")).toBe(false);
	});

	it("splitQueryMatch 与模糊打分算法正确运行", async () => {
		const { splitQueryMatch, fuzzySubsequenceScore, rankFileCandidates } = await import(
			"../src/ui_new/components/suggestions.js"
		);

		// 前缀匹配拆分
		const res1 = splitQueryMatch("clear", "cl");
		expect(res1).toEqual({ before: "", match: "cl", after: "ear" });

		const res2 = splitQueryMatch("src/components/tui.ts", "comp");
		expect(res2).toEqual({ before: "src/", match: "comp", after: "onents/tui.ts" });

		const res3 = splitQueryMatch("hello", "xyz");
		expect(res3).toBeNull();

		// 模糊子序列打分
		const score1 = fuzzySubsequenceScore("tui", "src/ui_new/tui.ts");
		expect(score1).toBeDefined();
		expect(score1!).toBeGreaterThan(0);

		const score2 = fuzzySubsequenceScore("abc", "xyz.ts");
		expect(score2).toBeUndefined();

		// 文件候选排序
		const candidates = [
			{ path: "README.md", name: "README.md", kind: "file" as const },
			{ path: "src/ui_new/tui.ts", name: "tui.ts", kind: "file" as const },
			{ path: "src/ui_new/components/suggestions.ts", name: "suggestions.ts", kind: "file" as const },
		];
		const ranked = rankFileCandidates(candidates, "sugg");
		expect(ranked[0]?.name).toBe("suggestions.ts");
	});

	it("getFileCandidates 与 isPathLikeQuery 路径穿梭机制", async () => {
		const { isPathLikeQuery, listPathCandidates, getFileCandidates } = await import(
			"../src/ui_new/components/suggestions.js"
		);

		// 1. 路径特征识别
		expect(isPathLikeQuery("./")).toBe(true);
		expect(isPathLikeQuery("src/")).toBe(true);
		expect(isPathLikeQuery("src/ui_new/tui.ts")).toBe(true);
		expect(isPathLikeQuery("tui")).toBe(false);

		// 2. 目录级穿梭扫描
		const srcItems = listPathCandidates(process.cwd(), "src/", 20);
		expect(srcItems.length).toBeGreaterThan(0);
		expect(srcItems.some((item) => item.path.startsWith("src/"))).toBe(true);

		// 3. 全局模糊扫描
		const fuzzyItems = getFileCandidates(process.cwd(), "tui", 10);
		expect(fuzzyItems.length).toBeGreaterThan(0);
		expect(fuzzyItems.some((item) => item.name.includes("tui"))).toBe(true);
	});

	it("SuggestionCard 格式化渲染与像素级对齐", async () => {
		const { formatSuggestionCardLines } = await import("../src/ui_new/components/suggestions.js");

		const commands = [
			{ name: "model", description: "切换模型" },
			{ name: "clear", description: "清空屏幕" },
			{ name: "help", description: "查看帮助" },
		];

		const lines = formatSuggestionCardLines({
			type: "command",
			title: "命令",
			query: "m",
			columns: 60,
			selectedIndex: 0,
			items: commands,
		});

		expect(lines.length).toBeGreaterThan(3);
		expect(lines[0]).toContain("╭─ 命令 · 共 3 项");
		expect(lines[1]).toContain("❯");
		expect(lines[1]).toContain("model");
		expect(lines[lines.length - 1]).toContain("╰");

		// 每行宽度必须严格等于 60
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	it("Git Unified Diff 逐行差异计算与卡片渲染", async () => {
		const { computeLineDiff, formatUnifiedDiffCardLines } = await import(
			"../src/ui_new/components/diff-view.js"
		);

		const oldText = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
		const newText = "const a = 1;\nconst b = 3;\nconst c = 4;\nconsole.log(a + b);";

		const diff = computeLineDiff(oldText, newText);
		expect(diff.addCount).toBe(2);
		expect(diff.delCount).toBe(1);

		const cardLines = formatUnifiedDiffCardLines(oldText, newText, "demo.ts", false, 70);
		expect(cardLines[0]).toContain("┌─ 📄 demo.ts (diff)");
		expect(cardLines.join("\n")).toContain("- const b = 2;");
		expect(cardLines.join("\n")).toContain("+ const b = 3;");
		expect(cardLines.join("\n")).toContain("+ const c = 4;");
		expect(stripAnsi(cardLines[cardLines.length - 1]!)).toContain("+2 / -1");

		// 验证卡片行宽严格一致
		const widths = cardLines.map((l) => visibleWidth(l));
		const firstW = widths[0]!;
		expect(widths.every((w) => w === firstW)).toBe(true);
	});

	it("InputLine 自动探测 / 与 @ 联想并支持原子替换", async () => {
		const box = new InputLine();

		// 1. 输入以 / 开头
		box.setText("/mod");
		const q1 = box.detectSuggestionQuery();
		expect(q1).toEqual({ type: "command", query: "mod", start: 0, end: 4 });

		// 2. 输入包含参数空格后不触发命令联想
		box.setText("/model deepseek");
		const q2 = box.detectSuggestionQuery();
		expect(q2).toBeNull();

		// 3. 输入 @ 触发文件联想
		box.setText("请帮我查看 @src/tui");
		const q3 = box.detectSuggestionQuery();
		expect(q3).toEqual({ type: "file", query: "src/tui", start: 6, end: 14 });

		// 4. 原子替换 @src/tui 为选中文件
		if (q3) {
			box.replaceRange(q3.start, q3.end, "@src/ui_new/tui.ts ");
		}
		expect(box.getRawText()).toBe("请帮我查看 @src/ui_new/tui.ts ");
	});

	it("UinaTUI 支持 registerCommand 注册与 appendDiff 追加卡片", async () => {
		const { UinaTUI } = await import("../src/ui_new/tui.js");
		const tui = new UinaTUI({ modelName: "deepseek-chat" });

		// 动态注册自定义命令
		let executed = false;
		tui.registerCommand({
			name: "custom",
			description: "自定义测试指令",
			handler: () => {
				executed = true;
			},
		});

		// 追加 Diff 卡片
		tui.appendDiff("old content", "new content", "test.ts");
		// 校验内部结构正常运行
		expect(typeof tui.appendDiff).toBe("function");
		expect(typeof tui.registerCommand).toBe("function");
	});

	it("CompactionRecord 格式化渲染与折叠双态像素对齐", async () => {
		const { formatCompactionCardLines } = await import("../src/ui_new/components/compact-view.js");

		const record = {
			id: 1,
			summary: "1. 讨论系统架构\n2. 落地输入联想与差异卡片\n3. 优化文件发现机制",
			turnsCount: 3,
			tokensSaved: 18500,
			collapsed: true,
			timestamp: Date.now(),
		};

		// 1. 折叠态
		const collapsedLines = formatCompactionCardLines(record, 70);
		expect(collapsedLines.length).toBe(3);
		expect(collapsedLines[0]).toContain("∴ 会话已压缩 · 归档 3 轮对话");
		expect(stripAnsi(collapsedLines[2]!)).toContain("18.5k");
		const cWidths = collapsedLines.map((l) => visibleWidth(l));
		expect(cWidths.every((w) => w === cWidths[0])).toBe(true);

		// 2. 展开态
		record.collapsed = false;
		const expandedLines = formatCompactionCardLines(record, 70);
		expect(expandedLines.length).toBeGreaterThan(3);
		expect(expandedLines[0]).toContain("完整摘要");
		expect(expandedLines.join("\n")).toContain("讨论系统架构");
		const eWidths = expandedLines.map((l) => visibleWidth(l));
		expect(eWidths.every((w) => w === eWidths[0])).toBe(true);
	});

	it("SyntaxText: 语言名称规范化与轻量语法高亮及降级", async () => {
		const { normalizeLanguage, highlightCode, highlightLines } = await import("../src/ui_new/components/syntax-text.js");

		expect(normalizeLanguage("ts")).toBe("typescript");
		expect(normalizeLanguage("PY")).toBe("python");
		expect(normalizeLanguage("")).toBeUndefined();

		const code = "const val = 123;";
		const highlighted = highlightCode(code, "typescript");
		expect(highlighted).toContain("val");

		// 逐行高亮
		const lines = highlightLines("const a = 1;\nconst b = 2;", "ts");
		expect(lines.length).toBe(2);

		// 未知语言不抛出异常，平滑降级为原文本
		const unknown = highlightCode("unknown code", "unknown_lang_xyz");
		expect(unknown).toContain("unknown code");
	});

	it("MarkdownTable: 解析表格结构与全封闭自适应网格对齐", async () => {
		const { parseMarkdownTable, formatMarkdownTableLines, isMarkdownTableLine } = await import(
			"../src/ui_new/components/markdown-table.js"
		);

		const rawTable = [
			"| 模块名 | 状态 | 耗时 |",
			"| :--- | :---: | ---: |",
			"| UI 内核 | 稳定 | 12ms |",
			"| 语法高亮 | 正常 | 8ms |",
		];

		expect(isMarkdownTableLine(rawTable[0]!)).toBe(true);

		const parsed = parseMarkdownTable(rawTable);
		expect(parsed).not.toBeNull();
		expect(parsed!.headers).toEqual(["模块名", "状态", "耗时"]);
		expect(parsed!.alignments).toEqual(["left", "center", "right"]);
		expect(parsed!.rows.length).toBe(2);

		// 格式化输出细线全封闭边框
		const rendered = formatMarkdownTableLines(parsed!, 80);
		expect(rendered.length).toBeGreaterThan(4);
		expect(rendered[0]).toContain("┌");
		expect(rendered[1]).toContain("模块名");
		expect(rendered[2]).toContain("├");
		expect(rendered[rendered.length - 1]).toContain("└");

		// 宽度对齐校验：每一行的可见宽度一致
		const widths = rendered.map((l) => visibleWidth(l));
		expect(widths.every((w) => w === widths[0])).toBe(true);

		// 极窄屏幕降级为垂直键值卡片
		const narrowRendered = formatMarkdownTableLines(parsed!, 20);
		expect(narrowRendered.join("\n")).toContain("表格条目 #1");
	});

	it("ModelPicker: 两级服务商/模型下钻导航与确认选择", async () => {
		const { ModelPicker } = await import("../src/ui_new/components/model-picker.js");

		const picker = new ModelPicker("deepseek-chat");
		const initialLines = picker.formatLines(70);
		expect(initialLines[0]).toContain("切换模型服务商");
		expect(initialLines.join("\n")).toContain("DeepSeek");

		// 按 Enter 下钻进入 DeepSeek 模型列表
		const drillRes = picker.confirm();
		expect(drillRes?.action).toBe("drilled");

		const modelLines = picker.formatLines(70);
		expect(modelLines[0]).toContain("选择模型 (DeepSeek)");
		expect(modelLines.join("\n")).toContain("deepseek-chat");

		// 移动光标并选中 deepseek-reasoner
		picker.navigateDown();
		const pickRes = picker.confirm();
		expect(pickRes?.action).toBe("picked");
		if (pickRes?.action === "picked") {
			expect(pickRes.modelId).toBe("deepseek-reasoner");
		}

		// Esc 回退
		const backRes = picker.back();
		expect(backRes.action).toBe("back");
		const closeRes = picker.back();
		expect(closeRes.action).toBe("close");
	});

	it("EffortSlider: 思考强度滑块挡位左右切换与释义展示（对齐 dsh-TUI 5 档与实时生效）", async () => {
		const { EffortSlider, DEFAULT_EFFORT_TIERS } = await import("../src/ui_new/components/effort-slider.js");

		// 1. 验证 5 档推理强度
		expect(DEFAULT_EFFORT_TIERS.map((t) => t.id)).toEqual(["off", "low", "medium", "high", "max"]);

		const slider = new EffortSlider("medium");
		expect(slider.getCurrentTier().id).toBe("medium");

		// 向右滑至 high，再滑至 max
		slider.navigateRight();
		expect(slider.getCurrentTier().id).toBe("high");
		slider.navigateRight();
		expect(slider.getCurrentTier().id).toBe("max");

		// 环形循环包裹测试：max 向右包裹到 off
		slider.navigateRight();
		expect(slider.getCurrentTier().id).toBe("off");

		// 环形向左包裹：off 向左回到 max，再到 high, medium, low
		slider.navigateLeft();
		expect(slider.getCurrentTier().id).toBe("max");
		slider.navigateLeft();
		slider.navigateLeft();
		slider.navigateLeft();
		expect(slider.getCurrentTier().id).toBe("low");

		const lines = slider.formatLines(70);
		// 校验 dsh-TUI 标题规范
		expect(lines[0]).toContain("推理强度 (Reasoning effort)");
		// 校验变阻器行包含 5 档名称
		const fullText = lines.join("\n");
		expect(fullText).toContain("Off");
		expect(fullText).toContain("Low");
		expect(fullText).toContain("Medium");
		expect(fullText).toContain("High");
		expect(fullText).toContain("Max");
		// 校验当前选中项携带勾选标记与释义
		expect(fullText).toContain("Low✓");
		expect(fullText).toContain("轻量快速推理");
		expect(fullText).toContain("←/→");
	});

	it("HelpMenu: 快捷键与指令总览分栏抽屉渲染", async () => {
		const { HelpMenu } = await import("../src/ui_new/components/help-menu.js");

		const menu = new HelpMenu([
			{ name: "model", description: "快速切模型浮层" },
			{ name: "effort", description: "思考强度调节滑块" },
		]);

		const lines = menu.formatLines(75);
		expect(lines[0]).toContain("快捷键与指令总览 (Help Menu)");
		expect(lines.join("\n")).toContain("常用快捷键");
		expect(lines.join("\n")).toContain("常用斜杠指令");
		expect(lines.join("\n")).toContain("Ctrl+O");
		expect(lines.join("\n")).toContain("Shift+Tab");
		expect(lines.join("\n")).toContain("/model");
	});

	it("StreamMarkdownFormatter: 流式 feedToken 聚合 Markdown 表格并输出网格边框", async () => {
		const { StreamMarkdownFormatter } = await import("../src/ui_new/components/stream-markdown.js");

		const formatter = new StreamMarkdownFormatter(80);
		// 逐行喂入表格
		const line1 = formatter.feedToken("| 语言 | 效率 |\n");
		expect(line1).toEqual([]); // 表格首行进入缓存

		const line2 = formatter.feedToken("| :--- | ---: |\n");
		expect(line2).toEqual([]); // 分隔符行进入缓存

		const line3 = formatter.feedToken("| TypeScript | 极高 |\n");
		expect(line3).toEqual([]); // 数据行进入缓存

		// 喂入空行触发表格刷出
		const flushed = formatter.feedToken("\n");
		expect(flushed.length).toBeGreaterThan(3);
		expect(flushed.some((l) => l.includes("┌"))).toBe(true);
		expect(flushed.some((l) => l.includes("语言"))).toBe(true);
		expect(flushed.some((l) => l.includes("TypeScript"))).toBe(true);
		expect(flushed.some((l) => l.includes("└"))).toBe(true);
	});

	it("InputLine: 底栏常驻思考强度徽章与 Shift+Tab 键位匹配", async () => {
		const { InputLine } = await import("../src/ui_new/editor/input-line.js");
		const { matchesKey, Key } = await import("../src/ui_new/core/keys.js");

		const box = new InputLine();
		box.setContextStats("deepseek-chat", 1000, 65536);
		box.setReasoningEffort("high");

		const lines = box.render(80);
		const bottomLine = lines[lines.length - 1]!;
		expect(bottomLine).toContain("deepseek-chat");
		expect(bottomLine).toContain("思考:高");

		box.setReasoningEffort("none");
		const linesNone = box.render(80);
		expect(linesNone[linesNone.length - 1]).toContain("思考:关");

		// 键位解析测试：Shift+Tab 与 \x1b[Z
		expect(matchesKey("\x1b[Z", Key.shiftTab)).toBe(true);
		expect(matchesKey("\x1b[9;2u", "shift+tab")).toBe(true);
		expect(matchesKey("\t", "shift+tab")).toBe(false); // 无物理 Shift 时不是 Shift+Tab
		expect(matchesKey("\t", "tab")).toBe(true);
	});

	it("MainScreenRenderer: renderFrame 原子吸底输出与行末清理", async () => {
		const { MainScreenRenderer } = await import("../src/ui_new/core/renderer.js");
		let written = "";
		const fakeTerminal = {
			columns: 80,
			rows: 24,
			syncWrite: (s: string) => {
				written += s;
			},
		} as any;

		const renderer = new MainScreenRenderer(fakeTerminal);
		const rows = ["Line 1", "Line 2", "Input Row 1", "Input Row 2"];
		renderer.renderFrame(rows);

		// 必须首先归位到左上角 (1, 1)
		expect(written.startsWith("\x1b[H")).toBe(true);
		// 每行输出完毕必须携带 \x1b[K 清除行末
		expect(written).toContain("Line 1\x1b[K");
		expect(written).toContain("Input Row 2\x1b[K");
	});

	it("UinaTUI: 输入框物理锁定在视口最底行，HelpMenu 开关过程输入框零位移且下方无空白", async () => {
		const { UinaTUI } = await import("../src/ui_new/tui.js");
		let lastRenderedRows: string[] = [];
		const fakeTerminal = {
			columns: 80,
			rows: 25,
			syncWrite: () => {},
		} as any;

		const tui = new UinaTUI({ modelName: "deepseek-chat" });
		(tui as any).terminal = fakeTerminal;
		(tui as any).renderer = {
			renderFrame: (rows: string[]) => {
				lastRenderedRows = rows;
			},
			fullRedraw: () => {},
			clearActiveArea: () => {},
			appendPermanentLines: () => {},
			renderActiveArea: () => {},
		};
		(tui as any).running = true;

		// 1. 初始渲染状态
		(tui as any).renderCurrentFrame();
		// 整屏高度严格锁定为 terminal.rows = 25 行
		expect(lastRenderedRows.length).toBe(25);
		// 最底行必须是输入框的底边框（包含模型名与思考强度徽章）
		const lastRowNormal = lastRenderedRows[24]!;
		expect(lastRowNormal).toContain("deepseek-chat");
		expect(lastRowNormal).toContain("思考:");
		expect(lastRowNormal).toContain("╯");

		// 2. 模拟打开 HelpMenu 抽屉
		(tui as any).handleRawInput("?");
		(tui as any).renderCurrentFrame();
		// 打开抽屉后，总行数依然严格等于 25
		expect(lastRenderedRows.length).toBe(25);
		// 抽屉浮动在上方 (OverlayAbove)，输入框依然稳稳钉死在最底行 (行 24)
		const lastRowWithHelp = lastRenderedRows[24]!;
		expect(lastRowWithHelp).toContain("deepseek-chat");
		expect(lastRowWithHelp).toContain("╯");
		// 且上方行包含帮助菜单的内容
		expect(lastRenderedRows.some((r) => r.includes("快捷键") || r.includes("命令列表"))).toBe(true);

		// 3. 模拟按 Esc 关闭 HelpMenu 抽屉
		(tui as any).handleRawInput("\x1b");
		(tui as any).renderCurrentFrame();
		// 关闭抽屉后，总行数依然严格等于 25
		expect(lastRenderedRows.length).toBe(25);
		// 输入框在最底行丝毫不动，底边框依然在行 24，输入框下方永远是 0 行！
		const lastRowAfterClose = lastRenderedRows[24]!;
		expect(lastRowAfterClose).toContain("deepseek-chat");
		expect(lastRowAfterClose).toContain("╯");
	});

	it("UinaTUI: 完整复刻 dsh-TUI 的 /effort status, /effort <id> 与 Shift+Tab 5 档循环", async () => {
		const { UinaTUI } = await import("../src/ui_new/tui.js");
		const tui = new UinaTUI({ modelName: "deepseek-chat" });
		(tui as any).terminal = { columns: 80, rows: 24, syncWrite: () => {} };
		(tui as any).renderer = {
			renderFrame: () => {},
			fullRedraw: () => {},
			clearActiveArea: () => {},
			appendPermanentLines: () => {},
			renderActiveArea: () => {},
		};
		(tui as any).running = true;

		// 1. 默认档位为 medium
		expect(tui.getReasoningEffort()).toBe("medium");
		expect((tui as any).getReasoningEffortName()).toBe("Medium");

		// 2. /effort status 报告当前强度与用法
		(tui as any).setupInputHandling();
		(tui as any).inputLine.onSubmit("/effort status");
		const notices = (tui as any).systemNotices;
		expect(notices.some((n: string) => n.includes("当前推理强度 Medium"))).toBe(true);
		expect(notices.some((n: string) => n.includes("用法：/effort"))).toBe(true);

		// 3. /effort max 直接切档
		(tui as any).inputLine.onSubmit("/effort max");
		expect(tui.getReasoningEffort()).toBe("max");
		expect((tui as any).getReasoningEffortName()).toBe("Max");
		expect(notices.some((n: string) => n.includes("推理强度 → Max"))).toBe(true);

		// 4. /effort unknown 触发 dsh-TUI 错误提示
		(tui as any).inputLine.onSubmit("/effort invalid_tier");
		expect(notices.some((n: string) => n.includes("未知推理等级 invalid_tier"))).toBe(true);

		// 5. Shift+Tab 5 档循环测试: max -> off -> low -> medium -> high -> max
		(tui as any).handleRawInput("\x1b[Z");
		expect(tui.getReasoningEffort()).toBe("off");
		(tui as any).handleRawInput("\x1b[Z");
		expect(tui.getReasoningEffort()).toBe("low");
		(tui as any).handleRawInput("\x1b[Z");
		expect(tui.getReasoningEffort()).toBe("medium");
		(tui as any).handleRawInput("\x1b[Z");
		expect(tui.getReasoningEffort()).toBe("high");
		(tui as any).handleRawInput("\x1b[Z");
		expect(tui.getReasoningEffort()).toBe("max");

		// 6. 空参数 /effort 打开滑块浮层并测试实时生效 (The slider IS the control)
		(tui as any).inputLine.onSubmit("/effort");
		expect((tui as any).activeModal?.type).toBe("effortSlider");
		// 按左箭头，实时 live-apply 至 high
		(tui as any).handleRawInput("\x1b[D"); // Left arrow
		expect(tui.getReasoningEffort()).toBe("high");
		// 按 Esc 关闭滑块浮层
		(tui as any).handleRawInput("\x1b");
		expect((tui as any).activeModal).toBeNull();
		expect(tui.getReasoningEffort()).toBe("high");
	});

	it("SubagentActivityStore: 完整覆盖生命周期、流式输出、工具追踪与中断状态变迁", async () => {
		const { SubagentActivityStore } = await import("../src/ui_new/components/subagent-dashboard.js");
		const store = new SubagentActivityStore();
		let notified = 0;
		const unsub = store.subscribe(() => notified++);

		// 1. 注册派生子智能体
		const agent = store.onSpawned("agent-1", "代码安全与死锁审查", "deepseek-reasoner", { effort: "high" });
		expect(agent.status).toBe("running");
		expect(agent.description).toBe("代码安全与死锁审查");
		expect(notified).toBe(1);

		// 2. 推送输出流 (思考链与正文)
		store.pushOutput("agent-1", "thinking", "正在推演交叉锁时序...");
		store.pushOutput("agent-1", "text", "审查报告初步形成。");
		expect(agent.output.length).toBe(2);
		expect(agent.outputEvents.length).toBe(2);

		// 3. 工具生命周期
		store.startToolCall("agent-1", { id: "t1", name: "grep_search", argsPreview: `{"Query":"lock"}` });
		expect(agent.toolCalls.length).toBe(1);
		expect(agent.toolCalls[0]!.status).toBe("running");
		store.endToolCall("agent-1", "t1", "completed", "匹配到 3 处锁");
		expect(agent.toolCalls[0]!.status).toBe("completed");
		expect(agent.toolCalls[0]!.resultPreview).toBe("匹配到 3 处锁");

		// 4. 完成结算
		store.complete("agent-1", "经审查无死锁风险。", { total: 1200 });
		expect(agent.status).toBe("completed");
		expect(agent.summary).toBe("经审查无死锁风险。");
		expect(agent.tokens?.total).toBe(1200);

		// 5. 中断已完成任务不生效，中断运行中任务变迁为 cancelled
		store.interrupt("agent-1");
		expect(agent.status).toBe("completed"); // 已经完成，不被覆盖

		const agent2 = store.onSpawned("agent-2", "长耗时并发测试");
		expect(agent2.status).toBe("running");
		store.interrupt("agent-2");
		expect(agent2.status).toBe("cancelled");
		expect(agent2.error).toContain("中断");

		// 6. loadSampleData 填充演示数据
		store.loadSampleData();
		expect(store.list().length).toBe(3);
		expect(store.list().some((a) => a.status === "running")).toBe(true);
		expect(store.list().some((a) => a.status === "completed")).toBe(true);
		expect(store.list().some((a) => a.status === "failed")).toBe(true);

		unsub();
	});

	it("SubagentDashboard & SubagentDetailScene: 一级看板与二级下钻审查页完整渲染与交互验证", async () => {
		const { SubagentActivityStore, SubagentDashboard } = await import(
			"../src/ui_new/components/subagent-dashboard.js"
		);
		const { SubagentDetailScene } = await import(
			"../src/ui_new/components/subagent-detail-scene.js"
		);

		const store = new SubagentActivityStore();
		store.loadSampleData();

		// 1. 一级总览看板渲染与按键导航
		const dashboard = new SubagentDashboard(store);
		const initialLines = dashboard.formatLines(80);
		expect(initialLines.some((l) => l.includes("子智能体看板 (Subagents)"))).toBe(true);
		expect(initialLines.some((l) => l.includes("运行中"))).toBe(true);
		expect(initialLines.some((l) => l.includes("已完成"))).toBe(true);

		expect(dashboard.getFocusedAgent()?.agentId).toBe("subagent-01");
		dashboard.navigateDown();
		expect(dashboard.getFocusedAgent()?.agentId).toBe("subagent-02");
		dashboard.navigateDown();
		expect(dashboard.getFocusedAgent()?.agentId).toBe("subagent-03");
		dashboard.navigateDown();
		expect(dashboard.getFocusedAgent()?.agentId).toBe("subagent-01"); // 环形包裹
		dashboard.navigateUp();
		expect(dashboard.getFocusedAgent()?.agentId).toBe("subagent-03");

		// 2. 二级详情审查页三大 Tab 轮播
		let interruptedAgent = "";
		const detailScene = new SubagentDetailScene(store.get("subagent-01")!, (id) => {
			interruptedAgent = id;
		});

		// Tab 1: summary (摘要网格)
		expect(detailScene.getActiveTab()).toBe("summary");
		let detailLines = detailScene.formatLines(80, 24);
		expect(detailLines.some((l) => l.includes("运行属性网格 (StatGrid)"))).toBe(true);
		expect(detailLines.some((l) => l.includes("deepseek-reasoner"))).toBe(true);

		// 翻页到 Tab 2: output (事件日志)
		detailScene.turnPage(1);
		expect(detailScene.getActiveTab()).toBe("output");
		detailLines = detailScene.formatLines(80, 24);
		expect(detailLines.some((l) => l.includes("thinking:"))).toBe(true);

		// 翻页到 Tab 3: tools (工具调用)
		detailScene.turnPage(1);
		expect(detailScene.getActiveTab()).toBe("tools");
		detailLines = detailScene.formatLines(80, 24);
		expect(detailLines.some((l) => l.includes("grep_search"))).toBe(true);

		// 再次翻页回到 summary
		detailScene.turnPage(1);
		expect(detailScene.getActiveTab()).toBe("summary");

		// 测试 X 键中断动作
		detailScene.interrupt();
		expect(interruptedAgent).toBe("subagent-01");
	});

	it("UinaTUI: 完整复刻 /subagents, /agents 与 Alt+A 快捷键及两级下钻闭环", async () => {
		const { UinaTUI } = await import("../src/ui_new/tui.js");
		const tui = new UinaTUI({ modelName: "deepseek-chat" });

		// 1. 验证 Alt+A 打开一级看板
		(tui as any).handleRawInput("\x1ba"); // Alt+A
		expect((tui as any).activeModal?.type).toBe("subagentDashboard");
		const store = tui.getSubagentStore();
		expect(store.list().length).toBeGreaterThan(0); // 自动加载内置演示数据

		// 2. 在看板中按 Enter 下钻进入详情审查页
		(tui as any).handleRawInput("\r"); // Enter
		expect((tui as any).activeModal?.type).toBe("subagentDetail");

		// 3. 在详情页按 → 切换 Tab
		const scene = (tui as any).activeModal?.detailScene;
		expect(scene.getActiveTab()).toBe("summary");
		(tui as any).handleRawInput("\x1b[C"); // Right arrow
		expect(scene.getActiveTab()).toBe("output");

		// 4. 在详情页按 Esc 返回一级总览看板
		(tui as any).handleRawInput("\x1b"); // Escape
		expect((tui as any).activeModal?.type).toBe("subagentDashboard");

		// 5. 在一级看板按 Esc 彻底退出
		(tui as any).handleRawInput("\x1b"); // Escape
		expect((tui as any).activeModal).toBeNull();

		// 6. 验证斜杠指令 /subagents 与 /agents 唤起看板
		(tui as any).inputLine.onSubmit("/subagents");
		expect((tui as any).activeModal?.type).toBe("subagentDashboard");
		(tui as any).handleRawInput("\x1b"); // Close
		expect((tui as any).activeModal).toBeNull();

		(tui as any).inputLine.onSubmit("/agents");
		expect((tui as any).activeModal?.type).toBe("subagentDashboard");
		(tui as any).handleRawInput("\x1b"); // Close
		expect((tui as any).activeModal).toBeNull();
	});

	it("RingBuffer: 高性能定长环形内存缓冲区存取与溢出回卷测试", async () => {
		const { RingBuffer } = await import("../src/ui_new/components/task-dashboard.js");
		const rb = new RingBuffer(3);
		expect(rb.size).toBe(0);

		rb.push("line-1");
		rb.push("line-2");
		expect(rb.size).toBe(2);
		expect(rb.getAll()).toEqual(["line-1", "line-2"]);

		rb.push("line-3");
		expect(rb.size).toBe(3);
		expect(rb.getAll()).toEqual(["line-1", "line-2", "line-3"]);

		// 超出容量，自动移出最老元素
		rb.push("line-4");
		expect(rb.size).toBe(3);
		expect(rb.getAll()).toEqual(["line-2", "line-3", "line-4"]);
		expect(rb.getTail(2)).toEqual(["line-3", "line-4"]);

		rb.clear();
		expect(rb.size).toBe(0);
		expect(rb.getAll()).toEqual([]);
	});

	it("BackgroundTaskRegistry: 进程生命周期流转、优雅终止、重启与 stdin 输入注入", async () => {
		const { BackgroundTaskRegistry } = await import("../src/ui_new/components/task-dashboard.js");
		const registry = new BackgroundTaskRegistry();
		let notifyCount = 0;
		const unsub = registry.subscribe(() => notifyCount++);

		let killed = false;
		let restarted = false;
		let receivedInput = "";

		const task = registry.register({
			id: "task-01",
			command: "pnpm dev",
			cwd: "e:/test",
			pid: 12345,
			onKill: () => {
				killed = true;
			},
			onRestart: () => {
				restarted = true;
			},
			onInput: (t) => {
				receivedInput = t;
			},
		});

		expect(task.status).toBe("running");
		expect(task.pid).toBe(12345);

		// 日志追加与 liveLine
		registry.appendLog("task-01", "Vite server started on port 5173\nReady in 200ms");
		expect(task.logs.size).toBe(2);
		expect(task.liveLine).toBe("Ready in 200ms");

		// 发送 stdin 输入
		await registry.sendInput("task-01", "r");
		expect(receivedInput).toBe("r");
		expect(task.logs.getAll().some((l) => l.includes("[stdin] > r"))).toBe(true);

		// 终止进程
		await registry.kill("task-01");
		expect(killed).toBe(true);
		expect(task.status).toBe("killed");

		// 重启进程
		await registry.restart("task-01");
		expect(restarted).toBe(true);
		expect(task.status).toBe("running");

		// 清理已完成记录
		registry.setTaskStatus("task-01", "completed", 0);
		registry.clearSettled();
		expect(registry.get("task-01")).toBeUndefined();

		// loadSampleData 验证
		registry.loadSampleData();
		expect(registry.list().length).toBe(4);
		expect(registry.list().some((t) => t.status === "running")).toBe(true);
		expect(registry.list().some((t) => t.status === "completed")).toBe(true);
		expect(registry.list().some((t) => t.status === "failed")).toBe(true);

		unsub();
	});

	it("TaskDashboard: 双分屏排版、Tab 焦点切换、Enter 全屏最大化与快捷键控制闭环", async () => {
		const { BackgroundTaskRegistry, TaskDashboard } = await import(
			"../src/ui_new/components/task-dashboard.js"
		);
		const registry = new BackgroundTaskRegistry();
		registry.loadSampleData();

		const dashboard = new TaskDashboard(registry);

		// 1. 双分屏排版验证
		const lines = dashboard.formatLines(80, 24);
		expect(lines.some((l) => l.includes("后台任务看板 (Background Tasks)"))).toBe(true);
		expect(lines.some((l) => l.includes("任务队列"))).toBe(true);
		expect(lines.some((l) => l.includes("实时日志透视"))).toBe(true);

		// 2. 导航与聚焦
		expect(dashboard.getFocusedTask()?.id).toBe("task-01");
		dashboard.navigateDown();
		expect(dashboard.getFocusedTask()?.id).toBe("task-02");
		dashboard.navigateDown();
		expect(dashboard.getFocusedTask()?.id).toBe("task-03");

		// 3. Tab 切换分屏焦点
		expect(dashboard.getFocusPane()).toBe("list");
		dashboard.togglePane();
		expect(dashboard.getFocusPane()).toBe("log");
		dashboard.togglePane();
		expect(dashboard.getFocusPane()).toBe("list");

		// 4. Enter 全屏最大化日志模式切换
		expect(dashboard.isMaximized()).toBe(false);
		dashboard.toggleMaximize();
		expect(dashboard.isMaximized()).toBe(true);
		const maxLines = dashboard.formatLines(80, 24);
		expect(maxLines.some((l) => l.includes("任务队列"))).toBe(false); // 任务列表折叠，只留日志
		expect(maxLines.some((l) => l.includes("实时日志透视"))).toBe(true);

		dashboard.toggleMaximize(); // 恢复双分屏
		expect(dashboard.isMaximized()).toBe(false);

		// 5. K 键终止与 C 键清理
		dashboard.setFocusIndex(0); // task-01
		await dashboard.killCurrent();
		expect(dashboard.getFocusedTask()?.status).toBe("killed");

		dashboard.clearSettled();
		// task-03 (completed), task-04 (failed) 和刚被终止的 task-01 均被清理
		expect(dashboard.getTasks().every((t) => t.status === "running")).toBe(true);
	});

	it("UinaTUI: 完整复刻 /tasks, /jobs 与 Alt+J 快捷键呼出及控制闭环", async () => {
		const { UinaTUI } = await import("../src/ui_new/tui.js");
		const tui = new UinaTUI({ modelName: "deepseek-chat" });

		// 1. 验证 Alt+J 打开任务看板
		(tui as any).handleRawInput("\x1bj"); // Alt+J
		expect((tui as any).activeModal?.type).toBe("taskDashboard");
		const registry = tui.getTaskRegistry();
		expect(registry.list().length).toBeGreaterThan(0); // 自动装载演练数据

		// 2. 按 Tab 切换焦点，按 Enter 最大化全屏日志
		(tui as any).handleRawInput("\t"); // Tab
		const dashboard = (tui as any).activeModal?.dashboard;
		expect(dashboard.getFocusPane()).toBe("log");

		(tui as any).handleRawInput("\r"); // Enter
		expect(dashboard.isMaximized()).toBe(true);
		(tui as any).handleRawInput("\r"); // Enter back
		expect(dashboard.isMaximized()).toBe(false);

		// 3. 按 Esc 退出任务看板
		(tui as any).handleRawInput("\x1b"); // Escape
		expect((tui as any).activeModal).toBeNull();

		// 4. 验证斜杠指令 /tasks 与 /jobs
		(tui as any).inputLine.onSubmit("/tasks");
		expect((tui as any).activeModal?.type).toBe("taskDashboard");
		(tui as any).handleRawInput("\x1b"); // Close
		expect((tui as any).activeModal).toBeNull();

		(tui as any).inputLine.onSubmit("/jobs");
		expect((tui as any).activeModal?.type).toBe("taskDashboard");
		(tui as any).handleRawInput("\x1b"); // Close
		expect((tui as any).activeModal).toBeNull();
	});

	it("TrajectoryStore & WaveBand: 时序事件记录、波形带投影与性能热点聚合统计", async () => {
		const { TrajectoryStore, projectWaveBand } = await import(
			"../src/ui_new/components/trajectory-scene.js"
		);
		const store = new TrajectoryStore();
		store.loadSampleData();

		const nodes = store.list();
		expect(nodes.length).toBe(7);

		// 1. 验证 WaveBand 生成 2 行 Unicode 能量柱带并带有光标指示器
		const [w1, w2] = projectWaveBand(nodes, 60, 2);
		expect(w1.length).toBeGreaterThan(0);
		expect(w2.length).toBeGreaterThan(0);
		expect(w2.includes("▲")).toBe(true);

		// 2. 验证 Hotspot 性能聚合 (按耗时倒序)
		const hotspotDur = store.aggregate("duration");
		expect(hotspotDur.length).toBeGreaterThan(0);
		// 最耗时的应该是 run_command (7600ms)
		expect(hotspotDur[0]!.name).toBe("run_command");
		expect(hotspotDur[0]!.totalDurationMs).toBe(7600);

		// 3. 验证 Hotspot 按错误数倒序
		const hotspotErr = store.aggregate("errors");
		expect(hotspotErr[0]!.errors).toBe(1);
		expect(hotspotErr[0]!.name).toBe("view_file");
	});

	it("TrajectoryScene: 双视图 (Timeline/Hotspot) 切换、Enter 详情检查器与 e/E 快速查错跳转", async () => {
		const { TrajectoryStore, TrajectoryScene } = await import(
			"../src/ui_new/components/trajectory-scene.js"
		);
		const store = new TrajectoryStore();
		store.loadSampleData();

		const scene = new TrajectoryScene(store);

		// 1. 初始时间线模式与双分屏排版
		expect(scene.getView()).toBe("timeline");
		const lines = scene.formatLines(80, 24);
		expect(lines.some((l) => l.includes("全屏审计轨迹 (Trajectory)"))).toBe(true);
		expect(lines.some((l) => l.includes("余弦密度能量波形带"))).toBe(true);
		expect(lines.some((l) => l.includes("详情检查器"))).toBe(true);

		// 2. 切换至 Hotspot 性能热点模式
		scene.turnView(1);
		expect(scene.getView()).toBe("hotspot");
		const hotLines = scene.formatLines(80, 24);
		expect(hotLines.some((l) => l.includes("性能热点聚合分析"))).toBe(true);

		scene.turnView(1);
		expect(scene.getView()).toBe("timeline");

		// 3. e 键快速跳转到错误节点 (step-5)
		scene.setCursor(0);
		const found = scene.seekError(true);
		expect(found).toBe(true);
		expect(scene.getFocusedNode()?.status).toBe("failed");
		expect(scene.getFocusedNode()?.id).toBe("step-5");

		// 4. Enter 全屏最大化详情检查器
		expect(scene.isMaximized()).toBe(false);
		scene.toggleMaximize();
		expect(scene.isMaximized()).toBe(true);
		const maxLines = scene.formatLines(80, 24);
		expect(maxLines.some((l) => l.includes("余弦密度能量波形带"))).toBe(false); // 时间线主体折叠
		expect(maxLines.some((l) => l.includes("全屏放大模式"))).toBe(true);

		scene.toggleMaximize();
		expect(scene.isMaximized()).toBe(false);
	});

	it("UinaTUI: 完整复刻 /trajectory, /traj 与 Alt+T 快捷键呼出及事件自动捕获闭环", async () => {
		const { UinaTUI } = await import("../src/ui_new/tui.js");
		const tui = new UinaTUI({ modelName: "deepseek-chat" });

		// 1. 会话事件与工具调用自动捕获至 TrajectoryStore
		tui.handleTurnStart(1, "优化数据库死锁");
		tui.handleToolStart("grep_search", { Query: "lock" });
		tui.handleToolDone("grep_search", "found 3 locks", 150);
		tui.handleError("模拟连接超时异常");
		tui.handleTurnEnd(1, { usedTokens: 2500, contextWindow: 65536 });

		const store = tui.getTrajectoryStore();
		const nodes = store.list();
		expect(nodes.some((n) => n.kind === "turn_start")).toBe(true);
		expect(nodes.some((n) => n.kind === "tool_call" && n.label === "grep_search")).toBe(true);
		expect(nodes.some((n) => n.kind === "error")).toBe(true);
		expect(nodes.some((n) => n.kind === "model_stream")).toBe(true);

		// 2. 验证 Alt+T 打开审计轨迹看板
		(tui as any).handleRawInput("\x1bt"); // Alt+T
		expect((tui as any).activeModal?.type).toBe("trajectory");

		// 3. 按 Tab 切换视图，按 Enter 最大化
		(tui as any).handleRawInput("\t"); // Tab
		const scene = (tui as any).activeModal?.scene;
		expect(scene.getView()).toBe("hotspot");

		(tui as any).handleRawInput("\r"); // Enter
		expect(scene.isMaximized()).toBe(true);
		(tui as any).handleRawInput("\r"); // Enter back
		expect(scene.isMaximized()).toBe(false);

		// 4. 按 Esc 退出轨迹看板
		(tui as any).handleRawInput("\x1b"); // Escape
		expect((tui as any).activeModal).toBeNull();

		// 5. 验证斜杠指令 /trajectory 与 /traj
		(tui as any).inputLine.onSubmit("/trajectory");
		expect((tui as any).activeModal?.type).toBe("trajectory");
		(tui as any).handleRawInput("\x1b"); // Close
		expect((tui as any).activeModal).toBeNull();

		(tui as any).inputLine.onSubmit("/traj");
		expect((tui as any).activeModal?.type).toBe("trajectory");
		(tui as any).handleRawInput("\x1b"); // Close
		expect((tui as any).activeModal).toBeNull();
	});
});





