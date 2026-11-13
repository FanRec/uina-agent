import { describe, expect, it } from "vitest";
import { ExpressionDecoder, OutputInterpreter, OutputTagRegistry } from "../src/agent/expression.js";
import type { ExpressionAnnotation, ExpressionEvent } from "../src/core/expression.js";
import { stripExpressionTags } from "../src/core/expression.js";

function tags(): Map<string, { name: string; kind: "block" | "marker" }> {
	return new Map<string, { name: string; kind: "block" | "marker" }>([
		["speech", { name: "speech", kind: "block" }],
		[
			"cue",
			{
				name: "cue",
				kind: "marker",
				attributes: { id: "required-string", target: "optional-string" },
			} as never,
		],
	]);
}

function newDecoder(): ExpressionDecoder {
	return new ExpressionDecoder("s1", tags());
}

/** 规范化：合并相邻同 scope 文本事件（分块无关性的前提）。 */
function normalize(events: readonly ExpressionEvent[]): ExpressionEvent[] {
	const merged: ExpressionEvent[] = [];
	for (const event of events) {
		const last = merged[merged.length - 1];
		if (
			event.kind === "text" &&
			last?.kind === "text" &&
			last.streamId === event.streamId &&
			(last.scope?.blockId ?? undefined) === (event.scope?.blockId ?? undefined) &&
			(last.scope?.name ?? undefined) === (event.scope?.name ?? undefined) &&
			last.rawRange[1] === event.rawRange[0]
		) {
			merged[merged.length - 1] = {
				...last,
				text: last.text + event.text,
				rawRange: [last.rawRange[0], event.rawRange[1]],
			};
			continue;
		}
		merged.push(event);
	}
	return merged;
}

function feedAll(decoder: ExpressionDecoder, chunks: readonly string[]): ExpressionEvent[] {
	const events: ExpressionEvent[] = [];
	for (const chunk of chunks) events.push(...decoder.feed(chunk));
	events.push(...decoder.finish("completed"));
	return normalize(events);
}

describe("ExpressionDecoder", () => {
	it("单块完整输入产生 block_start → text → marker → text → block_end", () => {
		const events = feedAll(newDecoder(), ['<speech>你好<cue id="nod"/>！</speech>']);
		expect(events.map((e) => (e.kind === "text" ? "text" : e.kind))).toEqual([
			"block_start",
			"text",
			"marker",
			"text",
			"block_end",
		]);
		const marker = events[2]!;
		expect(marker.kind === "marker" && marker.attributes).toEqual({ id: "nod" });
		expect(marker.kind === "marker" && marker.blockId).toBe("speech-1");
		const close = events[4]!;
		expect(close.kind === "block_end" && close.reason).toBe("closed");
		expect(close.kind === "block_end" && close.rawRange).toEqual([26, 35]);
	});

	it("随机分块输入与单块输入等价（规范化合并后）", () => {
		const whole = feedAll(newDecoder(), ['<speech>你好<cue id="nod"/>！</speech>']);
		const split = feedAll(newDecoder(), ["<spe", "ech>你", "好<cue id='nod'/>！", "</speech>", ""]);
		expect(split).toEqual(whole);
	});

	it("rawRange 是完整原文中的 UTF-16 半开区间，文字范围与标签范围不重叠", () => {
		const raw = "前置<speech>内文</speech>后置";
		const events = feedAll(newDecoder(), [raw]);
		expect(events[0]).toMatchObject({ kind: "text", text: "前置", rawRange: [0, 2] });
		expect(events[1]).toMatchObject({ kind: "block_start", rawRange: [2, 10] });
		expect(events[2]).toMatchObject({
			kind: "text",
			text: "内文",
			rawRange: [10, 12],
			scope: { blockId: "speech-1", name: "speech" },
		});
		expect(events[3]).toMatchObject({ kind: "block_end", rawRange: [12, 21] });
		expect(events[4]).toMatchObject({ kind: "text", text: "后置", rawRange: [21, 23] });
	});

	it("output_end 隐式封口：已打开未闭合的 Speech 以 ended 结束且无关闭区间", () => {
		const events = feedAll(newDecoder(), ["<speech>未闭合"]);
		expect(events.at(-1)).toMatchObject({ kind: "block_end", reason: "ended" });
		expect(events.at(-1)!.kind === "block_end" && events.at(-1)!.rawRange).toBeUndefined();
	});

	it("interrupted 收尾以 interrupted 结束", () => {
		const decoder = newDecoder();
		decoder.feed("<speech>部分");
		const events = normalize(decoder.finish("interrupted"));
		expect(events.at(-1)).toMatchObject({ kind: "block_end", reason: "interrupted" });
	});

	it("未知属性、重复属性、缺失必需属性与无效标签都是字面文本", () => {
		const cases = ['<cue foo="x"/>', '<cue id="a" id="b"/>', "<cue/>", "<speech x>内文</speech>"];
		for (const raw of cases) {
			const events = feedAll(newDecoder(), [raw]);
			expect(events.map((e) => e.kind)).toEqual(["text"]);
			expect(events[0]!.kind === "text" && events[0]!.text).toBe(raw);
		}
	});

	it("未注册标签与错位闭合按字面保留", () => {
		for (const raw of ["<other>x</other>", "外文</speech>内文"]) {
			const events = feedAll(newDecoder(), [raw]);
			expect(events.map((e) => e.kind)).toEqual(["text"]);
			expect(events[0]!.kind === "text" && events[0]!.text).toBe(raw);
		}
	});

	it("未配对的 </speech> 与 Speech 内再次出现的 <speech> 都是字面文本", () => {
		const events = feedAll(newDecoder(), ["<speech>a<speech>b</speech>c"]);
		const kinds = events.map((e) => (e.kind === "text" ? `text:${e.text}` : e.kind));
		expect(kinds).toEqual(["block_start", "text:a<speech>b", "block_end", "text:c"]);
	});

	it("Markdown 围栏与行内代码内的标签不触发效果，代码内容按原文保留", () => {
		const raw = '```\n<cue id="nod"/>\n```\n之后<cue id="nod"/>';
		const events = feedAll(newDecoder(), [raw]);
		const markers = events.filter((e) => e.kind === "marker");
		expect(markers).toHaveLength(1);
		const code = events.find((e) => e.kind === "text" && e.text.includes("<cue"));
		expect(code).toBeDefined();
		const rawInline = '行内 `<cue id="nod"/>` 与 <cue id="nod"/>';
		const inlineEvents = feedAll(newDecoder(), [rawInline]);
		expect(inlineEvents.filter((e) => e.kind === "marker")).toHaveLength(1);
	});

	it("被反斜杠转义的标签按字面文本处理", () => {
		const events = feedAll(newDecoder(), ['\\<cue id="nod"/>']);
		expect(events.map((e) => e.kind)).toEqual(["text"]);
		expect(events[0]!.kind === "text" && events[0]!.text).toBe('\\<cue id="nod"/>');
	});

	it("未闭合代码区域持续字面；finish 释放残余", () => {
		const events = feedAll(newDecoder(), ["```js\nconst a = '<cue id=\"nod\"/>';\n"]);
		expect(events.filter((e) => e.kind === "marker")).toHaveLength(0);
		const last = events.at(-1)!;
		expect(last.kind === "text" && last.text.endsWith("';\n")).toBe(true);
	});

	it("不同 Stream 相互隔离，blockId 按流内次序稳定", () => {
		const a = new ExpressionDecoder("a", tags());
		const b = new ExpressionDecoder("b", tags());
		const aOpen = a.feed("<speech>一");
		const bOpen = b.feed("<speech>二");
		const aClose = normalize([...a.feed("</speech>"), ...a.finish("completed")]);
		const bClose = normalize(b.finish("completed"));
		expect(aOpen[0]).toMatchObject({ kind: "block_start", streamId: "a", blockId: "speech-1" });
		expect(bOpen[0]).toMatchObject({ kind: "block_start", streamId: "b", blockId: "speech-1" });
		expect(aClose.at(-1)).toMatchObject({ kind: "block_end", streamId: "a", reason: "closed" });
		expect(bClose.at(-1)).toMatchObject({ kind: "block_end", streamId: "b", reason: "ended" });
	});

	it("同一流多个依次排列的 Speech Block 各自获得稳定 blockId", () => {
		const events = feedAll(newDecoder(), ["<speech>一</speech><speech>二</speech>"]);
		expect(events.filter((e) => e.kind === "block_start").map((e) => e.blockId)).toEqual(["speech-1", "speech-2"]);
	});

	it("Speech 未闭合前就能流式发出带 scope 的增量文本", () => {
		const decoder = newDecoder();
		const first = decoder.feed("<speech>第一段。");
		expect(first).toHaveLength(2);
		expect(first[0]).toMatchObject({ kind: "block_start" });
		expect(first[1]).toMatchObject({ kind: "text", text: "第一段。", scope: { name: "speech" } });
	});

	it("单字符与逐字符输入产生同一规范化结果", () => {
		const raw = "前<speech>内<cue id='nod'/>尾</speech>后";
		const whole = feedAll(newDecoder(), [raw]);
		const perChar = feedAll(newDecoder(), raw.split(""));
		expect(perChar).toEqual(whole);
	});
});

describe("OutputTagRegistry", () => {
	it("注册名在一个 Host 内唯一，重名拒绝并报告所有者", () => {
		const registry = new OutputTagRegistry();
		registry.register("ext-a", { name: "speech", kind: "block" }, () => true);
		expect(() => registry.register("ext-b", { name: "speech", kind: "block" }, () => true)).toThrow(/ext-a/);
	});

	it("扩展卸载释放注册；新流使用最新注册表", () => {
		const registry = new OutputTagRegistry();
		const unregister = registry.register("ext-a", { name: "speech", kind: "block" }, () => true);
		expect(registry.snapshot().has("speech")).toBe(true);
		unregister();
		expect(registry.snapshot().has("speech")).toBe(false);
	});

	it("不活跃注册不进入快照", () => {
		const registry = new OutputTagRegistry();
		let active = false;
		registry.register("ext-a", { name: "cue", kind: "marker", attributes: { id: "required-string" } }, () => active);
		expect(registry.snapshot().size).toBe(0);
		active = true;
		expect(registry.snapshot().size).toBe(1);
	});
});

describe("OutputInterpreter 注解", () => {
	it("已识别标签产生注解，无标签流不产生注解", () => {
		const interpreter = new OutputInterpreter();
		interpreter.startStream("s1", tags());
		interpreter.feed("s1", "纯文本，没有标签。");
		interpreter.finish("s1", "completed");
		expect(interpreter.takeAnnotation("s1")).toBeUndefined();

		interpreter.startStream("s2", tags());
		interpreter.feed("s2", '<speech>你好<cue id="nod"/></speech>');
		interpreter.finish("s2", "completed");
		const annotation = interpreter.takeAnnotation("s2");
		expect(annotation).toBeDefined();
		expect(annotation!.version).toBe(1);
		expect(annotation!.streamId).toBe("s2");
		expect(annotation!.tags.map((t) => t.kind)).toEqual(["block_start", "marker", "block_end"]);
	});

	it("中断流的注解记录 interrupted 隐式结束", () => {
		const interpreter = new OutputInterpreter();
		interpreter.startStream("s3", tags());
		interpreter.feed("s3", "<speech>部分内容");
		interpreter.finish("s3", "interrupted");
		const annotation = interpreter.takeAnnotation("s3")!;
		expect(annotation.tags.at(-1)).toEqual({
			kind: "block_end",
			name: "speech",
			blockId: "speech-1",
			reason: "interrupted",
		});
	});

	it("注解区间可以剔除标签原文并保留其余原文", () => {
		const interpreter = new OutputInterpreter();
		interpreter.startStream("s4", tags());
		const raw = '说明<speech>台词<cue id="nod"/></speech>结尾';
		interpreter.feed("s4", raw);
		interpreter.finish("s4", "completed");
		const annotation = interpreter.takeAnnotation("s4") as ExpressionAnnotation;
		expect(stripExpressionTags(raw, annotation)).toBe("说明台词结尾");
	});
});
