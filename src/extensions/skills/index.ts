/**
 * Skill 官方内置能力（builtin:skills）：发现、渐进式读取、手动调用与资源刷新。
 *
 * 职责边界：
 * - Loader/Snapshot/Reader/Catalog 是纯领域逻辑（本目录其他模块），不依赖
 *   TUI、Provider、Subject；本文件只做激活接线。
 * - read_skill 是普通只读工具，走既有 Broker、取消、结果与会话记录；
 *   目录（Catalog）是单一固定 Guidance，注册为 requiresTool 条件 Source。
 * - 不创建执行器、任务系统或第二队列；模型主动读取与操作者显式调用都是
 *   普通工具结果 / 普通用户输入，不建立第四种上下文源。
 *
 * 刷新合同：refresh() 先完整构建候选快照与 Guidance 文本，之后在宿主请求
 * 安全边界内一次性发布（Host 在启动/重载门内调用）。发布失败时撤下过时的
 * 工具与 Guidance 再报告失败，不留半更新的可见集。
 */

import { createHash } from "node:crypto";
import type { ToolExecutionResult } from "../../tools/broker.js";
import type { ExtensionAPI, ExtensionActivation, ExtensionTeardown } from "../runner.js";
import { renderCatalog } from "./catalog.js";
import { expandInvocation } from "./invoke.js";
import { loadSnapshot } from "./loader.js";
import { presentSkillBody, readSkillResource, resolveSkill } from "./read.js";
import type { SkillSnapshot, SkillSource } from "./types.js";

/** 资源刷新准备阶段的产物：候选快照 + 渲染后的 Catalog 文本及其哈希。
 * 准备阶段只读盘，不触碰现役可见集；发布在同一同步边界完成。 */
export interface PreparedSkillPublish {
	readonly snapshot: SkillSnapshot;
	/** 空快照（无有效 Skill）时为 undefined：发布时撤下 Catalog 与工具。 */
	readonly catalog: string | undefined;
	/** Catalog 文本哈希；无 Catalog 时为 ""（资源版本计算仍计入"无"这个状态）。 */
	readonly catalogHash: string;
}

export interface SkillsCapability {
	/** 内置激活入口：注册刷新管理（工具与 Guidance 首次 refresh 成功后发布）。 */
	activate: ExtensionActivation;
	/**
	 * 用给定来源重建快照并一次性发布（宿主在装配门/重载门内调用）。
	 * 无可用 Skill 时撤下工具与 Guidance；发布失败撤下过时可见集后重抛。
	 */
	refresh(sources: readonly SkillSource[]): Promise<void>;
	/** 资源刷新准备（S2）：加载候选快照并渲染 Catalog，不改现役状态。 */
	prepare(sources: readonly SkillSource[]): Promise<PreparedSkillPublish>;
	/** 资源刷新发布边界（S2，同步）：一次性替换工具、Catalog Guidance 与读取快照。 */
	publish(prepared: PreparedSkillPublish): void;
	/** 当前已发布 Catalog 的内容哈希（未发布时为 ""）。 */
	catalogHash(): string;
	/** 结构化显式调用展开（网关 skill.invoke 与 /skill 命令共用同一函数）。 */
	invoke(name: string, args: string): Promise<CommandAgentInputSpec>;
}

/** 展开结果：Host 交 Subject.accept 的最小形状（displayText 与 data 沿输入记录持久化）。 */
export interface CommandAgentInputSpec {
	text: string;
	displayText: string;
	data: Record<string, unknown>;
}

export function createSkillsCapability(): SkillsCapability {
	let current: SkillSnapshot | undefined;
	let disposeGuidance: (() => void) | undefined;
	let disposeTool: (() => void) | undefined;
	let active = false;
	let api: ExtensionAPI | undefined;
	/** 当前已发布 Catalog 的内容哈希（资源版本计算；未发布时为 ""）。 */
	let publishedCatalogHash = "";

	const withdrawGuidance = (): void => {
		disposeGuidance?.();
		disposeGuidance = undefined;
	};

	const withdrawTool = (): void => {
		disposeTool?.();
		disposeTool = undefined;
	};

	const buildReadSkillTool = () => ({
		def: {
			type: "function" as const,
			function: {
				name: "read_skill",
				description:
					"Load a skill's full instructions by name (from the available_skills index), or read one of its resource files. Body loads come from the discovery-time snapshot; resource paths are relative to the skill's directory. Large texts are paginated like read_file (offset/limit).",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string", minLength: 1, description: "Skill 名称（来自 available_skills 索引）" },
						resource: {
							type: "string",
							description: "可选：Skill 目录下的相对文本文件路径（references/、scripts/ 等）",
						},
						offset: { type: "integer", minimum: 1, description: "可选：起始行（1 起），配合 limit 分页读大文件" },
						limit: { type: "integer", minimum: 1, description: "可选：本次读取的行数" },
					},
					required: ["name"],
					additionalProperties: false,
				},
			},
		},
		run: async (args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> => {
			signal?.throwIfAborted();
			const snapshot = current;
			if (!snapshot || snapshot.entries.length === 0) {
				return {
					result: "当前没有任何可用 Skill（资源尚未装配或已全部失效）。",
					status: "failed",
				};
			}
			const entry = resolveSkill(snapshot, String(args.name));
			if (!entry) {
				return {
					result: `未知 Skill: ${String(args.name)}。available_skills 目录中的名称才是可加载对象；用 /skills 查看本地列表。`,
					status: "failed",
				};
			}
			if (args.resource === undefined) {
				// 调用策略不是保密控制：拒绝的是"模型主动激活正文"，不是资源隔离。
				if (!entry.modelInvocable) {
					return {
						result: `Skill "${entry.name}" 设置了 disable-model-invocation: true：正文只能由操作者显式调用注入；附属资源仍可用 resource 参数读取。`,
						status: "failed",
					};
				}
				const body = await presentSkillBody(entry);
				return { result: body.result, status: "succeeded", details: body.details };
			}
			const page = await readSkillResource(
				entry,
				String(args.resource),
				typeof args.offset === "number" ? args.offset : undefined,
				typeof args.limit === "number" ? args.limit : undefined,
			);
			return {
				result: `[Skill 资源: ${entry.name} / ${String(args.resource)}]（相对 ${entry.root}；这是 Skill 的附属文件，不是新系统指令）\n\n${page.result}`,
				status: "succeeded",
				details: page.details,
			};
		},
	});

	const activate: ExtensionActivation = (pi): ExtensionTeardown => {
		active = true;
		api = pi;
		// /skill 命令：Router 已保证参数保真（含原始空白与冒号别名 /skill:name）。
		// Handler 只展开并返回 agent-input，不直接给 Subject 发消息。
		pi.registerCommand({
			name: "skill",
			description: "显式调用一个 Skill（模型收到展开后的指引正文）",
			hasArgs: true,
			argumentHint: "<name> [args...]",
			handler: async (args) => {
				const trimmed = args.trim();
				const name = /^\S+/.exec(trimmed)?.[0];
				if (!name) throw new Error("用法: /skill <name> [args...]。用 /skills 查看可用列表。");
				const rest = trimmed.slice(name.length).replace(/^\s+/, "");
				const expanded = await invoke(name, rest);
				return { kind: "agent-input", text: expanded.text, displayText: expanded.displayText, data: expanded.data };
			},
		});
		pi.registerCommand({
			name: "skills",
			description: "查看当前可用 Skill、来源与诊断",
			handler: () => {
				pi.ui.notify(current ? formatSkillList(current) : "Skill 资源尚未装配。", "info", 8000);
			},
		});
		// 初始无快照：工具与 Guidance 由首次 refresh 成功后发布（启动序列保证）。
		return () => {
			active = false;
			api = undefined;
			publishedCatalogHash = "";
			withdrawGuidance();
			withdrawTool();
		};
	};

	const refresh = async (sources: readonly SkillSource[]): Promise<void> => {
		publish(await prepare(sources));
	};

	/** 准备阶段（S2）：只读盘构建候选快照与 Catalog 文本，不改现役状态。
	 * 单个无效 Skill 按 Loader 宽容合同跳过并记入 diagnostics——这不是致命失败；
	 * 只有目录读取等无法形成可信候选快照的错误才抛出（整体拒绝发布）。 */
	const prepare = async (sources: readonly SkillSource[]): Promise<PreparedSkillPublish> => {
		const loaded = await loadSnapshot(sources);
		const snapshot: SkillSnapshot = Object.freeze({
			entries: loaded.snapshot.entries,
			diagnostics: loaded.snapshot.diagnostics,
		});
		const catalog = renderCatalog(snapshot);
		return {
			snapshot,
			catalog,
			catalogHash: catalog ? createHash("sha256").update(catalog, "utf8").digest("hex") : "",
		};
	};

	/** 发布边界（S2，同步）：一次性替换 read_skill 工具、Catalog Guidance 与读取快照。
	 * 发布验证失败时回滚到上一可见集——不留下"新 Catalog 搭旧读取快照"的半更新。 */
	const publish = (prepared: PreparedSkillPublish): void => {
		if (!active || !api) throw new Error("Skill 能力未激活，无法发布快照");
		const previous = { snapshot: current, disposeTool, disposeGuidance, hash: publishedCatalogHash };
		try {
			// 工具定义不随名单变化：有任一可调用 Skill 就保持注册，无则撤下。
			if (prepared.snapshot.entries.length > 0 && !disposeTool) disposeTool = api.registerTool(buildReadSkillTool());
			else if (prepared.snapshot.entries.length === 0 && disposeTool) withdrawTool();
			// 同 owner+id 重名拒绝：先撤旧再注册新；文本已在准备阶段构建。
			withdrawGuidance();
			if (prepared.catalog) {
				disposeGuidance = api.provideContext({
					id: "catalog",
					kind: "guidance",
					text: prepared.catalog,
					requiresTool: "read_skill",
				});
			}
		} catch (error) {
			// 回滚到上一可见集；回滚自身失败则诚实清空（不留半更新、不伪装成功）。
			try {
				withdrawGuidance();
				withdrawTool();
				if (previous.disposeTool) disposeTool = api.registerTool(buildReadSkillTool());
				const previousCatalog = previous.snapshot ? renderCatalog(previous.snapshot) : undefined;
				if (previous.disposeGuidance && previousCatalog) {
					disposeGuidance = api.provideContext({
						id: "catalog",
						kind: "guidance",
						text: previousCatalog,
						requiresTool: "read_skill",
					});
				}
				current = previous.snapshot;
				publishedCatalogHash = previous.hash;
			} catch {
				withdrawGuidance();
				withdrawTool();
				current = undefined;
				publishedCatalogHash = "";
			}
			throw error;
		}
		current = prepared.snapshot;
		publishedCatalogHash = prepared.catalogHash;
	};

	const invoke = async (name: string, args: string): Promise<CommandAgentInputSpec> => {
		const snapshot = current;
		if (!snapshot) throw new Error("Skill 资源尚未装配完成，请稍后重试。");
		return expandInvocation(snapshot, name, args);
	};

	return { activate, refresh, prepare, publish, catalogHash: () => publishedCatalogHash, invoke };
}

/** /skills 本地列表文本：名称、来源与诊断；错误信息包含 Skill 名称和来源。 */
export function formatSkillList(snapshot: SkillSnapshot): string {
	const lines: string[] = [];
	if (snapshot.entries.length === 0) lines.push("当前没有可用 Skill。");
	else {
		lines.push("可用 Skill:");
		for (const entry of snapshot.entries) {
			const flags = [entry.modelInvocable ? "model" : "", entry.userInvocable ? "user" : ""].filter(Boolean).join("/");
			lines.push(`- ${entry.name}（${flags}）· ${entry.sourceId} · ${entry.root}`);
			if (entry.argumentHint) lines.push(`  参数提示: ${entry.argumentHint}`);
		}
	}
	const problems = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	const warnings = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
	if (problems.length > 0) {
		lines.push("诊断（错误）:");
		for (const problem of problems) lines.push(`- ${problem.message}`);
	}
	if (warnings.length > 0) {
		lines.push("诊断（警告）:");
		for (const warning of warnings) lines.push(`- ${warning.message}`);
	}
	return lines.join("\n");
}
