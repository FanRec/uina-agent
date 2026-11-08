/**
 * Addon 纯值契约：跨 Host / Companion / IPC 只传这些结构，不传函数或类实例。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §2、§4。五个事实分开表达：
 * Installed（本机有包）/ Enabled（Profile 选择）/ Loaded（本次 Companion 装配）/
 * Compatible（特定协议/服务端条件经验证）/ Available（能力当前可调用）。
 * `serverRequirement` 是**声明**，任何字段都不代表服务端已安装。
 */

import type { CallableDescriptor, QueryDescriptor } from "./capabilities.js";
import type { JsonValue } from "./values.js";

export interface AddonServerRequirement {
	/** 环境类型：服务器插件、服务器 Mod，或两者皆可。 */
	kind: "plugin" | "mod" | "mod-or-plugin";
	id: string;
	/** connection = 缺少即无法登录；feature = 只影响该特性。 */
	requiredFor: "feature" | "connection";
	note?: string;
}

/** Parent 预检后交给 Companion 的单个包；路径与配置都是纯值。 */
export interface AddonPlanEntry {
	id: string;
	version: string;
	api: 1;
	/** 包根（绝对路径，已确认为安装根下的真实目录）。 */
	root: string;
	/** 入口文件（绝对路径，已确认位于包根内）。 */
	entry: string;
	/** Profile `addons.json` 里该包的配置值。 */
	config: JsonValue;
	/** Manifest 声明的兼容版本（空数组 = 未声明）。 */
	minecraft: string[];
	serverRequirement: AddonServerRequirement | null;
}

/** 一次会话冻结的装配计划：连接期间不变，重连才重新解析。 */
export interface AddonSelection {
	/** 选择摘要（id@version + 配置的稳定摘要），用于追溯本次会话实际装配了什么。 */
	digest: string;
	entries: AddonPlanEntry[];
}

/**
 * 目录快照里的包状态。`installed` 只表示本机有完整包（离线 describe）；
 * `loaded` 表示本次 Companion 已成功装配并贡献能力。
 */
export interface AddonStatus {
	id: string;
	version: string;
	api: 1;
	state: "installed" | "loaded";
	minecraft: string[];
	serverRequirement: AddonServerRequirement | null;
	/** 本机安装目录（只读诊断用，不参与执行）。 */
	dir: string;
	/** 装配摘要：贡献的动作/查询数量与确切 ref；未加载时为空。 */
	contributed: { actions: number; queries: number; knowledgeItems: number; refs: string[] };
}

/** `directory.snapshot` 的返回：唯一真值来自同一次 Companion 装配。 */
export interface DirectorySnapshot {
	launch: string;
	connection: "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	/** 活动会话的 descriptor 快照（与 Runtime/World 使用同一份装配结果）。 */
	descriptors: (QueryDescriptor | CallableDescriptor)[];
	addons: AddonStatus[];
	selection: { digest: string | null };
}
