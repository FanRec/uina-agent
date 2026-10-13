import { existsSync } from "node:fs";

/**
 * mpv 二进制定位：显式配置 > MPV_PATH 环境变量 > Windows 常见安装位置。
 * 供需要 mpv 的 world（soundboard、netease-jukebox）共用；找不到返回 null，
 * 由调用方决定降级策略（模拟播放器或不可用提示）。
 */
export function resolveMpvPath(customPath?: string): string | null {
	if (customPath && existsSync(customPath)) {
		return customPath;
	}
	if (process.env.MPV_PATH && existsSync(process.env.MPV_PATH)) {
		return process.env.MPV_PATH;
	}
	if (process.platform === "win32") {
		const candidates = [
			"C:\\Program Files\\MPV Player\\mpv.com",
			"C:\\Program Files\\MPV Player\\mpv.exe",
			"C:\\Program Files\\mpv\\mpv.com",
			"C:\\Program Files\\mpv\\mpv.exe",
			"C:\\Program Files (x86)\\mpv\\mpv.com",
			"C:\\Program Files (x86)\\mpv\\mpv.exe",
			"C:\\tools\\mpv\\mpv.com",
			"C:\\tools\\mpv\\mpv.exe",
			"E:\\Uina_Core\\tools\\mpv.exe",
		];
		for (const c of candidates) {
			if (existsSync(c)) {
				return c;
			}
		}
	}
	return null;
}
