/**
 * Uina Minecraft addon: SpectatorPlus 界面桥（api 1）。
 *
 * 职责只有一件事：把 Uina 自己的「个人背包窗口事务」起止，翻译成 SpectatorPlus
 * 已经会处理的服务器入站 Payload。不新建 Agent 工具、不发布事实、不订阅任何包。
 *
 * 为什么需要这一层：箱子/工作台/熔炉是**服务端创建**的窗口，SpectatorPlus 的
 * InventoryOpen/Close 监听本来就能自动镜像；而玩家个人背包（window 0）是纯客户端
 * 视图，服务端根本不知道它开了还是关了。上游为此留了 opened_inventory_sync 通道，
 * Fabric 端按 1 字节布尔解析：open = 01，close = 00。本包只发这两个字节。
 *
 * 只支持 Fabric 服务端（SpectatorPlus 作为服务端 Mod）。Paper 端不支持：上游 Paper
 * 插件把同一通道的空载荷当成"打开"，没有关闭处理，发 00 会被它再当成一次打开。
 * 要支持 Paper 必须改服务端插件，那属于上游的事，不在本包范围。
 *
 * 纯 ESM JavaScript，无运行时依赖：Companion 直接 import 本文件。
 */

const ADDON_ID = "spectatorplus";

/** 上游既有通道；服务端按 1 字节布尔解析。 */
const CHANNEL_SCREEN = "spectatorplus:opened_inventory_sync";

export default {
	api: 1,
	id: ADDON_ID,
	create({ logger }) {
		logger.info("local screen bridge ready");

		return {
			client: {
				/** 纯编码：不发送、不持有连接、不等待任何确认。 */
				localScreen(event) {
					if (event == null || event.kind !== "player_inventory") return null;
					return {
						channel: CHANNEL_SCREEN,
						data: Uint8Array.of(event.phase === "open" ? 1 : 0),
					};
				},
			},
		};
	},
};
