/**
 * Driver 模块公共入口（实现归 Driver 开发 AI；本文件签名是模块接缝）。
 *
 * 职责（docs/proposals/mc/modules/driver.md）：Mineflayer 私有客户端、连接与身份代次、
 * 身体资格与写入隔离、连续/离散控制、高频反馈、当前事实采样（ClientFactsPort）、窗口会话。
 *
 * 边界：不依赖具体玩法能力、不依赖 Uina 接入层；只能 import ../contracts/ 与自己的子模块。
 * 真实服务端验收是后续阶段；本切片先以 fake bot（替身物理/协议）交付可测行为。
 */

import type { ClientFactsPort } from "../contracts/client-facts.js";
import type { PlayerPort } from "../contracts/body.js";
import type { EffectReceipt } from "../contracts/values.js";

export interface DriverConfig {
	/** 服务器地址（连接位置，不是世界身份）。 */
	host: string;
	port: number;
	/** 协议版本；省略时由 Mineflayer 协商。 */
	version?: string;
	username: string;
	/** 本地测试可用 offline 验证模式。 */
	authMode?: "offline" | "microsoft";
}

export interface DriverHandle {
	/** 连接状态（connecting/syncing/ready/disconnected/faulted 的只读投影）。 */
	readonly connectionState: () => "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	/** 受控玩家端口：acquire 由运行管理调用。 */
	readonly player: PlayerPort;
	/** 当前客户端事实端口：由 World 订阅 + 采样。 */
	readonly facts: ClientFactsPort;
	/** 游戏聊天：不占身体、不参与身体调度（design §3 say 边界）。 */
	say(text: string, signal: AbortSignal): Promise<EffectReceipt>;
	close(): Promise<void>;
}

export function createDriver(_config: DriverConfig): DriverHandle {
	throw new Error("未实现：Driver 切片待 Driver 开发 AI 交付（保持本签名）");
}
