/**
 * 文本净化助手（TUI/stdio 共用）。工具卡片渲染已统一到 render-text.ts 的
 * renderToolBlock（§7 删除清单：format.ts 不再持有任何工具展示函数）。
 */

export function sanitizeTerminalText(value: string): string {
	return value.replace(
		/[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
		"",
	);
}

/** Drop C0 control characters (except tab/newline/CR) and Unicode format
 * characters. Pi does the same at the tool-output boundary
 * (coding-agent/src/utils/shell.ts sanitizeBinaryOutput). */
export function sanitizeBinaryOutput(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			out += char;
			continue;
		}
		if (code <= 0x1f) continue;
		if (code >= 0xfff9 && code <= 0xfffb) continue;
		out += char;
	}
	return out;
}

/** Text entering a rendered surface from an untrusted source (model output,
 * tool output, extension content): strip ANSI/OSC and control characters so a
 * payload cannot drive the terminal. */
export function sanitizeRenderText(value: string): string {
	return sanitizeBinaryOutput(sanitizeTerminalText(value));
}

/**
 * 只保留 SGR（颜色/属性）转义，剥掉其它一切转义与裸控制字符。
 *
 * 用于**工具输出**这类"要保留颜色、但绝不允许驱动光标"的内容：
 *   - 保留：`\x1b[32m` 这类颜色/属性序列（工具输出的绿/红/加粗都在这里）；
 *   - 剥掉：光标移动/定位/擦除（`\x1b[H`/`\x1b[2J`/`\x1b[K`）、OSC/APC、字符集
 *     （`\x1b(B`）等 —— 任何一个漏进帧都会让终端吞掉我们后面的定位/底色序列；
 *   - 丢弃：孤立 ESC 与其它 C0/C1/DEL（保留 \t\n\r 交给后续步骤处理）。
 *
 * 与 `sanitizeRenderText` 的区别就是"是否保留颜色"：前者全剥（不受信文本用），
 * 后者留 SGR（工具输出用，颜色是它的语义信息）。
 */
export function keepSgrOnly(value: string): string {
	if (!value) return "";
	const sgr = /\x1b\[[0-9;]*m/y;
	// sanitizeTerminalText 的同一套覆盖面（CSI/OSC/APC/字符集），锚定在当前位置整段剥掉
	const esc =
		/[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/y;
	let out = "";
	let i = 0;
	while (i < value.length) {
		if (value.charCodeAt(i) === 0x1b) {
			sgr.lastIndex = i;
			const kept = sgr.exec(value);
			if (kept) {
				out += kept[0];
				i += kept[0].length;
				continue;
			}
			esc.lastIndex = i;
			const dropped = esc.exec(value);
			i += dropped ? dropped[0].length : 1; // 非 SGR 转义整段丢弃；孤立 ESC 丢单字节
			continue;
		}
		const code = value.charCodeAt(i);
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			out += value[i];
		} else if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
			out += value[i];
		}
		i++;
	}
	return out;
}
