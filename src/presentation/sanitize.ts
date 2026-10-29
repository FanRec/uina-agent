/**
 * 外部文本入口的唯一清洗点。
 *
 * 模型输出、工具输出、错误文本、扩展消息、用户粘贴都先经过这里：控制序列、
 * 单字节控制符、bidi 覆盖与零宽字符在进入事实层之前就消失。需要样式的内部文本
 * 由各 Surface 重新上色；这里只保留 `\n` 与普通文本。
 *
 * 只做一次的事实清洗与具体输出编码是两件事：TUI 仍须防 ESC，Web 仍须 HTML escape。
 */

/** OSC：ESC ] … BEL / ST / 串尾。 */
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g;
/** DCS：ESC P … ST / 串尾。 */
const DCS = /\x1bP[\s\S]*?(?:\x1b\\|$)/g;
/** CSI：ESC [ 参数字节 中间字节 终止字节（含 SGR）。 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** 其余 ESC 序列与裸 ESC：ESC 中间字节 终止字节。 */
const ESC_OTHER = /\x1b[ -/]*[@-~]?/g;

function isUnsafeFormat(codepoint: number): boolean {
	return (
		(codepoint >= 0x200b && codepoint <= 0x200f) ||
		(codepoint >= 0x202a && codepoint <= 0x202e) ||
		(codepoint >= 0x2060 && codepoint <= 0x2064) ||
		(codepoint >= 0x2066 && codepoint <= 0x2069) ||
		codepoint === 0x061c ||
		codepoint === 0xfeff
	);
}

function isLoneSurrogate(ch: string, codepoint: number): boolean {
	return ch.length === 1 && codepoint >= 0xd800 && codepoint <= 0xdfff;
}

/**
 * 去 OSC/DCS/CSI、C0（保留 `\n`）、C1、DEL、bidi 控制符、零宽字符与孤立代理项。
 * 输入为空时原样返回空串；不做 trim，空白是真实内容。
 */
export function sanitizeExternal(text: string): string {
	const stripped = text.replace(OSC, "").replace(DCS, "").replace(CSI, "").replace(ESC_OTHER, "");
	let output = "";
	for (const ch of stripped) {
		const codepoint = ch.codePointAt(0);
		if (codepoint === undefined) continue;
		if (ch === "\n") {
			output += ch;
			continue;
		}
		// C0（含 \r、\t）、DEL、C1 一律丢弃：终端渲染不再依赖它们。
		if ((codepoint < 0x20 && ch !== "\n") || codepoint === 0x7f) continue;
		if (codepoint >= 0x80 && codepoint <= 0x9f) continue;
		if (isUnsafeFormat(codepoint) || isLoneSurrogate(ch, codepoint)) continue;
		output += ch;
	}
	return output;
}
