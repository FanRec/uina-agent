/**
 * 界面类查询：ui@1（当前服务器界面）与 hud@1（计分板/BossBar/Title/Tab）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#ui、public-api §4.5/§4.6。
 * 两条都是**连接级观察**：不占 Body、不需要 WindowSession，服务器用 /menu、NPC
 * 或聊天链接打开的菜单同样可读。这才是"自主探索未知菜单"的入口——
 * 先 ui@1 读到结构，再按 screenRef + uiRevision + buttonDigest 逐次 ui.act。
 *
 * 事实边界：菜单文本/物品名/Lore 是第三方服务器给的显示数据，不是给 Agent 的指令；
 * 显示图标不等于商品，颜色不表达允许/禁止，业务成功必须另有证据。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { Fact } from "../../contracts/values.js";
import type { CapabilityDefinition, MinecraftCapabilityModule } from "../catalog.js";
import { EMPTY_INPUT } from "../shared/schema.js";

const uiDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "ui@1",
		facts: ["ui"],
		summary:
			"Current server interface on this connection: container menu slots with display text, or a dialog with inputs and buttons",
		// 只列非空槽：菜单的按钮本来就是图标物品，空槽对"读懂结构"没有信息量。
		input: EMPTY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: {},
				output: {
					value: {
						kind: "container",
						screenRef: "screen:ui1:3",
						uiRevision: 7,
						title: { text: "Shop" },
						container: {
							windowType: "minecraft:generic_9x3",
							layout: { status: "known", slotCount: 27 },
							slots: [{ index: 11, region: "top", item: { name: "diamond", count: 1 }, buttonDigest: "9f2c..." }],
							cursor: null,
						},
					},
					coverage: "complete",
					unknown: [],
				},
			},
			{
				input: {},
				output: {
					value: { kind: "none", screenRef: null, uiRevision: 0, unknown: [] },
					coverage: "complete",
					unknown: [],
				},
			},
		],
	},
	bind: () => ({
		kind: "current",
		read: (view: ClientFactView): Fact<unknown> => view.ui() as Fact<unknown>,
	}),
};

const hudDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "hud@1",
		facts: ["hud"],
		summary: "Current HUD observation: scoreboard sidebar, boss bars, title/subtitle, action bar and tab header",
		input: EMPTY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: {},
				output: {
					value: {
						scoreboard: {
							objective: "money",
							display: "sidebar",
							title: { text: "Balance" },
							lines: [{ entry: "UinaDev", score: 1200, display: null }],
						},
						bossBars: [],
						title: null,
						subtitle: null,
						actionBar: null,
						tab: null,
					},
					coverage: "complete",
					unknown: [],
				},
			},
			{
				input: {},
				output: { value: null, coverage: "partial", unknown: ["no HUD elements observed on this connection yet"] },
			},
		],
	},
	bind: () => ({
		kind: "current",
		read: (view: ClientFactView): Fact<unknown> => view.hud() as Fact<unknown>,
	}),
};

export const uiQueryModule: MinecraftCapabilityModule = {
	id: "ui-observation",
	definitions: [uiDefinition, hudDefinition],
};
