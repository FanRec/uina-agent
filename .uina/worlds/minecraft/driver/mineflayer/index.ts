/**
 * 真实 Mineflayer 客户端工厂：Driver 的默认 botFactory。
 *
 * createBot 立即返回 bot，连接在后台推进；连接错误经 error/end 事件交给 ClientHost，
 * 这里不做重试，也不把"已创建"当成"已连接"。
 */

import { createBot } from "mineflayer";
import type { DriverConfig } from "../index.js";
import type { ClientBot } from "../internal/bot-shape.js";
import { MineflayerClientBot, type MineflayerBot } from "./client-bot.js";

export function createMineflayerBot(config: DriverConfig): ClientBot {
	return new MineflayerClientBot(
		createBot({
			host: config.host,
			port: config.port,
			username: config.username,
			// 本地服务器通常是 offline；微软认证须显式选择。
			auth: config.authMode ?? "offline",
			...(config.version ? { version: config.version } : {}),
		}) as unknown as MineflayerBot,
	);
}
