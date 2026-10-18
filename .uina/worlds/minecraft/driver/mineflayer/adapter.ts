/**
 * Mineflayer 原生适配层：客户端创建与窄类型收敛。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §3.1/§9。此处只做两类事：
 * 1. 客户端创建与窄类型收敛；2. 协议坐标类型转换。
 * pathfinder 插件适配在同目录 pathfinder.ts（driver/mineflayer/ 内可 import 插件）。
 * 不在适配层写玩法算法；资格、完成合同等业务语义属于 driver 其余模块。
 * 依赖组合固定：mineflayer 4.39.0 / minecraft-protocol 1.68.0（协议上限 1.21.11）、
 * mineflayer-pathfinder 2.4.5、vec3 0.1.7。
 */

import { createBot, type Bot } from "mineflayer";
import { createRequire } from "node:module";
import type { Vec3 } from "../../contracts/values.js";

/**
 * vec3 是 CJS 裸 module.exports 赋值，ESM 具名导入不可静态识别；
 * 经 createRequire 构造（与 engine.ts 的 Ajv 同一仓库惯例）。
 */
type MineflayerVec3 = import("vec3").Vec3;
const vec3Ctor = createRequire(import.meta.url)("vec3") as unknown as new (
	x: number,
	y: number,
	z: number,
) => MineflayerVec3;
/** 收敛后的客户端类型；driver 其余模块只经本文件接触 Bot。 */
export type { MineflayerVec3 };
type MineflayerBot = Bot;
export type { MineflayerBot };

export interface ClientOptions {
	host: string;
	port: number;
	username: string;
	/** 缺省由 minecraft-data 自动识别；固定组合下显式传入。 */
	version?: string;
}

/**
 * 显式 offline 登录（driver.md §4.1.1）：不请求 Microsoft 账号；
 * 服务器拒绝/版本不支持保留真实原因，由 ClientHost 判定状态，不在适配层伪造 ready。
 */
export function connectMinecraftClient(opts: ClientOptions): MineflayerBot {
	return createBot({
		host: opts.host,
		port: opts.port,
		username: opts.username,
		version: opts.version,
		auth: "offline",
	});
}

export function toMineflayerVec3(p: Vec3): MineflayerVec3 {
	return new vec3Ctor(p.x, p.y, p.z);
}

export function fromMineflayerVec3(v: MineflayerVec3 | null | undefined): Vec3 | null {
	if (v == null) return null;
	return { x: v.x, y: v.y, z: v.z };
}
