/**
 * Minecraft World — Uina 侧薄接入（技术负责人独占）。
 *
 * 职责（docs/proposals/mc/design.md §2 + contracts.md §3/§4）：World 生命周期、
 * minecraft façade 工具、事件递送、body.endpoint 急停门接入、与游戏执行进程通信。
 * 不实现游戏算法；执行侧（Driver/Executor/能力）在伴生进程中运行。
 *
 * 当前状态：执行侧未实现，façade 所有动作如实返回 not_started，不伪装能力。
 * defaultState.enabled = false，需显式启用。
 */

import type {
	ActionContext,
	ActionDef,
	ServiceCompanionContext,
	WorldDef,
} from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";

const NOT_IMPLEMENTED: ToolExecutionResult = {
	result:
		"minecraft 执行侧尚未装配（Driver/Executor 切片未交付）。本工具当前不产生任何游戏动作；受理、查询与急停能力将随执行侧切片一并开放。",
	status: "not_started",
};

const minecraftAction: ActionDef = {
	description: [
		"Minecraft 游戏世界操作入口。",
		"actions: observe（查询自身/方块/库存/历史）、describe（搜索能力签名）、",
		"run（调用能力/执行代码/运行已保存程序）、runs（查询进展/等待/停止/继续）、",
		"library（保存与检索程序/蓝图/经验）、say（游戏聊天）。",
		"执行侧未装配时所有动作返回 not_started。",
	].join(""),
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["observe", "describe", "run", "runs", "library", "say"],
				description: "操作类别",
			},
			params: { type: "object", description: "按 action 的参数，见 describe 返回的签名" },
		},
		required: ["action"],
	},
	run: async (_params: unknown, _ctx: ActionContext): Promise<ToolExecutionResult> => NOT_IMPLEMENTED,
};

export function createMinecraftWorldDef(_ctx?: ServiceCompanionContext): WorldDef {
	return {
		name: "minecraft",
		description:
			"Minecraft Java 版游戏环境。执行侧未装配时工具如实报告 not_started；装配后提供 observe/describe/run/runs/library/say。",
		actions: {
			minecraft: minecraftAction,
		},
		executionMode: "parallel",
		defaultState: { enabled: false },
	};
}

export default createMinecraftWorldDef;
