/**
 * Mineflayer 原生适配层：客户端创建与窄类型收敛。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §3.1/§9。此处只做两类事：
 * 1. 客户端创建与窄类型收敛；2. 协议坐标类型转换。
 * pathfinder 插件适配在同目录 pathfinder.ts（driver/mineflayer/ 内可 import 插件）。
 * 不在适配层写玩法算法；资格、完成合同等业务语义属于 driver 其余模块。
 * 依赖组合固定：mineflayer 4.39.0 / minecraft-protocol 1.68.0（协议上限 1.21.11）、
 * mineflayer-pathfinder 2.4.5。vec3 经 mineflayer 解析链取得（单一实例，不另设
 * 顶层依赖——生态统一 0.2.0，双版本并存会造成 Vec3 类不兼容）。
 */

import { createRequire } from "node:module";
import { type Bot, createBot } from "mineflayer";
import type { Vec3 } from "../../contracts/values.js";

/**
 * vec3 是 CJS 裸 module.exports 赋值，ESM 具名导入不可静态识别；经 mineflayer
 * 的解析链构造（与 protocol.ts 的 prismarine-* 同一惯例，保证与生态同一实例）。
 */
/** 与 mineflayer d.ts 的 Vec3（blockAt 首参）同源，避免再从顶层 import 'vec3' 类型。 */
type MineflayerVec3 = Parameters<import("mineflayer").Bot["blockAt"]>[0];
const vec3Ctor = createRequire(createRequire(import.meta.url).resolve("mineflayer/package.json"))(
	"vec3",
) as unknown as new (
	x: number,
	y: number,
	z: number,
) => MineflayerVec3;

/** 收敛后的客户端类型；driver 其余模块只经本文件接触 Bot。 */
export type { MineflayerVec3 };

/**
 * entities.js / bed.js 在运行时挂载但类型缺失的状态字段（批 18 收敛）：
 * vehicle 由 set_passengers/attach_entity/entityGone 驱动，未骑乘为 null；
 * isSleeping 由 pose 元数据驱动。只声明 Driver 实际读取的字段。
 */
type MineflayerBot = Bot & {
	vehicle?: { name?: string; position: MineflayerVec3 } | null;
	isSleeping?: boolean;
};

export type { MineflayerBot };

export interface ClientOptions {
	host: string;
	port: number;
	username: string;
	/**
	 * 必须显式给出：autoVersion 会在 createClient 期间独立发 status ping 并置
	 * wait_connect，与"全部协议贡献挂载完才放行连接"不兼容。真实服固定组合
	 * 由 executorConfigFromIdentity() 提供 MC_PROTOCOL_VERSION。
	 */
	version: string;
	/**
	 * Driver 自己创建的未连接 minecraft-protocol Client。
	 * createBot 接受 `client` 并跳过自建客户端：这是登录/配置阶段协议贡献的
	 * 唯一真实入口，Addon 拿不到它，也不能替换它。
	 */
	client?: unknown;
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
		...(opts.client == null ? {} : { client: opts.client as never }),
	});
}

export function toMineflayerVec3(p: Vec3): MineflayerVec3 {
	return new vec3Ctor(p.x, p.y, p.z);
}

export function fromMineflayerVec3(v: MineflayerVec3 | null | undefined): Vec3 | null {
	if (v == null) return null;
	return { x: v.x, y: v.y, z: v.z };
}
