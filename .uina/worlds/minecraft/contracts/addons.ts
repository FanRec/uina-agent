/**
 * Addon 纯值契约：跨 Host / Companion / IPC 只传这些结构，不传函数或类实例。
 *
 * 五个事实分开表达，任何一个都不由名字推导：
 * Installed（本机有不可变快照）/ Planned（依赖闭包通过静态校验）/ Loaded（代码初始化并贡献）/
 * ProtocolNegotiated（实际上游握手成功）/ DataReady（必需注册表已建立）。
 * `available` 不在这里——动作当前能否执行仍由 Catalog / World / Runtime 按实时环境判断。
 * `serverRequirement` 是静态声明，任何字段都不代表服务端已安装对应 Mod。
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

/** 递归依赖闭包里的单个已解析包；路径与配置都是纯值。 */
export interface ResolvedAddon {
	id: string;
	version: string;
	api: 1;
	/** 安装时计算的 artifact 全目录内容摘要；连接前复核，防止执行字节被换掉。 */
	artifactDigest: string;
	/** artifact 目录（绝对路径，已确认为安装根下的真实目录）。 */
	root: string;
	/** 入口文件（绝对路径，已确认位于包根内）。 */
	entry: string;
	config: JsonValue;
	/** 规范化配置的摘要；装配摘要里用它而不是原始对象。 */
	configDigest: string;
	/** 直接依赖 id（排序后），拓扑顺序的依据。 */
	dependencies: string[];
	/** 谁请求了它（排序后）；纯诊断，不参与执行。 */
	requestedBy: string[];
	minecraft: string[];
	serverRequirement: AddonServerRequirement | null;
}

/** 一次会话冻结的装配计划：连接期间不变，重连才重新解析。 */
export interface AssemblyPlan {
	/** Profile 显式请求的根包（排序后），不含自动纳入的前置。 */
	roots: string[];
	/** 依赖在前的拓扑顺序；加载按此顺序，释放按逆序。 */
	ordered: ResolvedAddon[];
	/** 按排序的 {id,version,api,artifactDigest,configDigest,dependencies} 计算的摘要。 */
	digest: string;
}

export interface DependencyError {
	code:
		| "ADDON_DEPENDENCY_MISSING"
		| "ADDON_DEPENDENCY_VERSION"
		| "ADDON_DEPENDENCY_CYCLE"
		| "ADDON_PROTOCOL_CONFLICT"
		| "ADDON_CONFIG_MISSING";
	/** root -> ... -> failing node，用于还原完整递归链。 */
	path: readonly string[];
	message: string;
}

export interface AddonStatusEvidence {
	/** 依赖闭包与静态校验通过。 */
	planned: boolean;
	/** create() 成功且贡献完成装配。 */
	loaded: boolean;
	/** unknown = 尚未装配；not_required = 未声明连接级协议贡献；其余由真实握手结果决定。 */
	protocol: "unknown" | "not_required" | "pending" | "negotiated" | "failed";
	/** 必需的注册表映射已真正建立；没有连接级数据时不成立。 */
	dataReady: boolean;
}

/** 目录快照里的包状态；离线状态只有 installed，没有 loaded。 */
export interface AddonStatus {
	id: string;
	version: string;
	api: 1;
	state: "installed" | "loaded";
	artifactDigest: string;
	evidence: AddonStatusEvidence;
	minecraft: string[];
	serverRequirement: AddonServerRequirement | null;
	/** 本机 artifact 目录（只读诊断用，不参与执行）。 */
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
