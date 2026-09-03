/**
 * Windows / 跨平台底层物理修饰键探测与控制台模式辅助模块。
 * 解决 Windows Terminal / ConPTY 默认丢弃 Shift+Enter 修饰键、将 Shift+Enter 当作普通 \r 发送的核心硬伤。
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const cjsRequire = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface NativeConsoleHelper {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed: (name: "shift" | "command" | "control" | "option") => boolean;
}

let helper: NativeConsoleHelper | null | undefined;

function loadHelper(): NativeConsoleHelper | undefined {
	if (helper !== undefined) return helper ?? undefined;
	helper = null;
	if (process.platform !== "win32") return undefined;

	const arch = process.arch;
	const nodeFile = arch === "arm64" ? "win32-arm64.node" : "win32-x64.node";
	const nativePath = path.join(__dirname, "native", nodeFile);

	try {
		const loaded = cjsRequire(nativePath) as NativeConsoleHelper;
		if (typeof loaded.isModifierPressed === "function") {
			helper = loaded;
			// 开启 Windows 控制台 VT 输入模式，保留修饰键
			try {
				helper.enableVirtualTerminalInput?.();
			} catch {
				// ignore
			}
			return helper;
		}
	} catch {
		// Native helper unavailable, fallback gracefully
	}
	return undefined;
}

/** 检查操作系统物理 Shift 键当前是否正被按住 */
export function isShiftPressed(): boolean {
	const h = loadHelper();
	if (!h) return false;
	try {
		return h.isModifierPressed("shift") === true;
	} catch {
		return false;
	}
}

/** 激活控制台 VT 输入（在终端启动时调用） */
export function initConsoleMode(): void {
	loadHelper();
}
