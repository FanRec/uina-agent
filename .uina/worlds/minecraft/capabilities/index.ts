/**
 * 能力面组合：内置模块清单 → 静态目录。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3–§4。
 * 每个模块自带 descriptor 与 bind 的配对；目录在创建时完成全部结构校验
 * （id/ref 唯一、schema 可编译），bind(deps) 只在 Companion 初始化时产生读写
 * 实现：World 先校验再读查询，Runtime 用 callables 执行动作，describe 直接读
 * 目录的静态 descriptor。重复 ref 在目录创建时显式失败——两套同名实现会让
 * 目录与执行分叉。测试与可信本地模块经 CapabilityCatalog.create 注入，不改此清单。
 */

import type { CallableDescriptor, QueryDescriptor } from "../contracts/capabilities.js";
import { activityModule } from "./actions/activity.js";
import { buildModule } from "./actions/build.js";
import { buildingModule } from "./actions/building.js";
import { carryingModule } from "./actions/carrying.js";
import { chatModule } from "./actions/chat.js";
import { collectModule } from "./actions/collect.js";
import { combatModule } from "./actions/combat.js";
import { containersModule } from "./actions/containers.js";
import { craftModule } from "./actions/craft.js";
import { excavateModule } from "./actions/excavate.js";
import { exploreModule } from "./actions/explore.js";
import { forgetModule } from "./actions/forget.js";
import { interactionModule } from "./actions/interaction.js";
import { itemsModule } from "./actions/items.js";
import { miningModule } from "./actions/mining.js";
import { navigationModule } from "./actions/navigation.js";
import { rememberModule } from "./actions/remember.js";
import { ridingModule } from "./actions/riding.js";
import { smeltModule } from "./actions/smelt.js";
import { stationsModule } from "./actions/stations.js";
import { surfaceModule } from "./actions/surface.js";
import { transitModule } from "./actions/transit.js";
import { tunnelModule } from "./actions/tunnel.js";
import { uiActModule } from "./actions/ui.js";
import { CapabilityCatalog, type MinecraftCapabilityModule } from "./catalog.js";
import { bodyModule } from "./queries/body.js";
import { buildPlanModule } from "./queries/build-plan.js";
import { containerLastModule } from "./queries/containers.js";
import { environmentModule } from "./queries/environment.js";
import { eventsModule } from "./queries/events.js";
import { knowledgeModule } from "./queries/knowledge.js";
import { mapModule } from "./queries/map.js";
import { placesModule } from "./queries/places.js";
import { playersModule } from "./queries/players.js";
import { regionModule } from "./queries/region.js";
import { routePlanModule } from "./queries/route-plan.js";
import { terrainModule } from "./queries/terrain.js";
import { uiQueryModule } from "./queries/ui.js";

export type { BuiltCapabilities } from "./catalog.js";

/**
 * 内置能力模块（顺序仅装配次序；目录按 ref 建索引，与次序无关）。
 * 新增能力 = 新模块文件加入此清单；测试/可信本地模块经 createCapabilityCatalog 注入，
 * 不需要改这里。
 */
export const builtinModules: readonly MinecraftCapabilityModule[] = [
	// 查询（World 读取面）
	bodyModule,
	terrainModule,
	regionModule,
	environmentModule,
	knowledgeModule,
	eventsModule,
	containerLastModule,
	placesModule,
	playersModule,
	mapModule,
	routePlanModule,
	buildPlanModule,
	// 连接级界面/HUD 观察：不占 Body，菜单由插件主动打开时同样可读。
	uiQueryModule,
	// 动作（Runtime 执行面）
	chatModule,
	navigationModule,
	miningModule,
	buildingModule,
	itemsModule,
	interactionModule,
	combatModule,
	carryingModule,
	collectModule,
	containersModule,
	craftModule,
	smeltModule,
	rememberModule,
	forgetModule,
	exploreModule,
	surfaceModule,
	tunnelModule,
	excavateModule,
	buildModule,
	stationsModule,
	activityModule,
	ridingModule,
	transitModule,
	uiActModule,
];

/**
 * 会话装配的唯一入口：内置模块 + 本次会话的 Addon 模块一次建成目录。
 * 目录创建即完成全部结构校验（重复 id/ref、坏 schema 显式失败）。
 */
export function createCapabilityCatalog(extra: readonly MinecraftCapabilityModule[] = []): CapabilityCatalog {
	return CapabilityCatalog.create([...builtinModules, ...extra]);
}

/**
 * 内置能力的静态 descriptor（离线 describe 用）。
 * 只覆盖内置模块：第三方能力只能来自活动 Companion 的目录快照，
 * 宿主不会为了离线展示去 import 未知扩展。
 */
export const builtinCatalog = CapabilityCatalog.create(builtinModules);
export const builtinDescriptors: readonly (QueryDescriptor | CallableDescriptor)[] = builtinCatalog.allDescriptors();
