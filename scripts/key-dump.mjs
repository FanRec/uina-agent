#!/usr/bin/env node
/**
 * B5.2 按键序列采集器 —— 在真实终端按键，打印每个输入块的原始十六进制。
 *
 * 背景：src/ui/core/keys.ts 中 ctrl+left/alt+left、ctrl+right/alt+right 的
 * 匹配表互相包含对方的转义序列（不同终端对同一物理组合发送的序列不同），
 * 消除歧义需要知道本机终端实际发送什么。采集结果贴回会话即可。
 *
 * 用法：node scripts/key-dump.mjs
 * 退出：单独输入 exit 后回车（Ctrl+C 本身是采集目标之一，不作退出键）。
 */

process.stdin.setRawMode(true);
process.stdin.resume();

console.log("── 按键序列采集器（B5.2）──────────────────────────");
console.log("逐个按下需要采集的组合键；输入 exit 后回车退出。");
console.log("建议序列：ctrl+←/→、alt+←/→、alt+↑/↓、alt+enter、");
console.log("shift+enter、ctrl+enter、alt+backspace、alt+o、alt+q");
console.log("──────────────────────────────────────────────────");

let line = "";

process.stdin.on("data", (chunk) => {
	const buf = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : Buffer.from(chunk);
	const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
	console.log(`${JSON.stringify(buf.toString("latin1"))}  <-  ${hex}  (${buf.length} 字节)`);

	// 单字母逐键到达，攒一行；出现非小写字母即视为组合键、清空缓冲
	const text = buf.toString("latin1");
	if (text === "\r" || text === "\n") {
		if (line === "exit") {
			process.stdin.setRawMode(false);
			process.stdin.pause();
			console.log("已退出。");
			process.exit(0);
		}
		line = "";
	} else if (text.length === 1 && text >= "a" && text <= "z") {
		line += text;
	} else {
		line = "";
	}
});

process.stdin.on("error", (error) => {
	console.error(`stdin 错误: ${error.message}`);
	process.exit(1);
});
