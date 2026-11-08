/**
 * Companion 侧 Addon 装配：唯一 import 第三方代码的地方。
 *
 * 约束：
 * - 只加载 Parent 预检过的冻结计划（拓扑顺序，依赖在前）；
 * - 模块自报的 id/api 必须与 Manifest 一致，否则拒绝装配；
 * - 贡献只转成 CapabilityModule / ProtocolExtension / KnowledgeSet，不新建执行层；
 * - 每个 create() 成功后**立刻**登记 close；后续任一步失败都逆序释放已创建的包，
 *   保留原始装配错误并附带清理异常，绝不留下未释放的 Addon。
 */

import { pathToFileURL } from "node:url";
import type { MinecraftCapabilityModule } from "../capabilities/catalog.js";
import type { AddonStatus, AssemblyPlan } from "../contracts/addons.js";
import type { ProtocolExtension } from "../contracts/protocol.js";
import { callFailure } from "../contracts/values.js";
import { addonCapabilityModule } from "./contribute.js";
import {
	ADDON_API_VERSION,
	type AddonContribution,
	type AddonDefinition,
	type AddonKnowledgeItem,
	type AddonLogger,
} from "./sdk.js";

export interface AddonKnowledgeSet {
	addonId: string;
	items: readonly AddonKnowledgeItem[];
}

export interface LoadedAddons {
	modules: MinecraftCapabilityModule[];
	extensions: ProtocolExtension[];
	knowledge: AddonKnowledgeSet[];
	statuses: AddonStatus[];
	close(): Promise<void>;
}

function loadFailure(code: string, message: string): Error {
	return callFailure({ code, source: "environment", message, dispatch: "not_sent", effects: [], recoverable: false });
}

function scopedLogger(id: string): AddonLogger {
	const write = (level: string, message: string, detail?: unknown): void => {
		const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
		console.log(`[mc-addon:${id}] ${level} ${message}${suffix}`);
	};
	return {
		info: (message, detail) => write("info", message, detail),
		warn: (message, detail) => write("warn", message, detail),
		error: (message, detail) => write("error", message, detail),
	};
}

function isDefinition(value: unknown, id: string): value is AddonDefinition {
	if (value == null || typeof value !== "object") return false;
	const candidate = value as Partial<AddonDefinition>;
	return candidate.api === ADDON_API_VERSION && candidate.id === id && typeof candidate.create === "function";
}

/** 运行时形状校验：贡献对象来自第三方代码，类型标注不能当作已验证。 */
function isContribution(value: unknown): value is AddonContribution {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as AddonContribution;
	if (candidate.actions !== undefined && !Array.isArray(candidate.actions)) return false;
	if (candidate.queries !== undefined && !Array.isArray(candidate.queries)) return false;
	if (candidate.knowledge !== undefined) {
		if (candidate.knowledge == null || typeof candidate.knowledge !== "object") return false;
		if (candidate.knowledge.items !== undefined && !Array.isArray(candidate.knowledge.items)) return false;
	}
	if (candidate.client !== undefined) {
		if (candidate.client == null || typeof candidate.client !== "object") return false;
		if (candidate.client.install !== undefined && typeof candidate.client.install !== "function") return false;
		if (candidate.client.attach !== undefined && typeof candidate.client.attach !== "function") return false;
		if (candidate.client.localScreen !== undefined && typeof candidate.client.localScreen !== "function") return false;
	}
	if (candidate.close !== undefined && typeof candidate.close !== "function") return false;
	return true;
}

/** 包内知识只接受 `namespace:path` 身份与可确证的展示字段；坏形状在装配前失败。 */
function assertKnowledgeItems(addonId: string, items: readonly AddonKnowledgeItem[]): void {
	for (const item of items as readonly unknown[]) {
		const candidate = item as Partial<AddonKnowledgeItem> | null;
		const name = candidate?.name;
		if (typeof name !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name))
			throw loadFailure(
				"ADDON_CONTRIBUTION_INVALID",
				`${addonId}: knowledge item name ${JSON.stringify(name)} is not "namespace:path"`,
			);
		if (typeof candidate?.displayName !== "string" || candidate.displayName.length === 0)
			throw loadFailure("ADDON_CONTRIBUTION_INVALID", `${addonId}: knowledge item ${name} needs a displayName`);
		if (!Number.isInteger(candidate.stackSize) || (candidate.stackSize as number) <= 0)
			throw loadFailure("ADDON_CONTRIBUTION_INVALID", `${addonId}: knowledge item ${name} needs a positive stackSize`);
		if (candidate.placeAs !== undefined && candidate.placeAs !== null && typeof candidate.placeAs !== "string")
			throw loadFailure(
				"ADDON_CONTRIBUTION_INVALID",
				`${addonId}: knowledge item ${name} placeAs must be a string or null`,
			);
	}
}

/** 加载一次冻结的计划；返回的 close() 与失败回滚共用同一个逆序释放链，且幂等。 */
export async function loadAddons(
	plan: AssemblyPlan | undefined,
	options: { minecraftVersion: string; logger?: AddonLogger },
): Promise<LoadedAddons> {
	const modules: MinecraftCapabilityModule[] = [];
	const extensions: ProtocolExtension[] = [];
	const knowledge: AddonKnowledgeSet[] = [];
	const statuses: AddonStatus[] = [];
	const closers: (() => void | Promise<void>)[] = [];
	let closing: Promise<void> | null = null;
	const releaseAll = (): Promise<void> =>
		(closing ??= (async () => {
			const errors: unknown[] = [];
			// 逆序释放，且不就地反转原数组（close 可能被启动失败路径再次调用）。
			for (const release of [...closers].reverse()) {
				try {
					await release();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "addon close failed");
		})());

	if (plan == null || plan.ordered.length === 0) return { modules, extensions, knowledge, statuses, close: releaseAll };

	try {
		for (const entry of plan.ordered) {
			const logger = options.logger ?? scopedLogger(entry.id);
			let contribution: AddonContribution;
			try {
				const imported = (await import(pathToFileURL(entry.entry).href)) as { default?: unknown } & Record<
					string,
					unknown
				>;
				const definition = imported.default ?? imported;
				if (!isDefinition(definition, entry.id))
					throw loadFailure(
						"ADDON_ENTRY_INVALID",
						`${entry.id}: entry module must export { api: 1, id: ${JSON.stringify(entry.id)}, create() }`,
					);
				const created = await definition.create({
					config: entry.config,
					minecraftVersion: options.minecraftVersion,
					logger,
				});
				// create() 一旦返回就取得资源所有权；形状校验之前也要能释放。
				closers.push(() => {
					const candidate = created as { close?: () => void | Promise<void> };
					return typeof candidate.close === "function" ? candidate.close() : undefined;
				});
				if (!isContribution(created))
					throw loadFailure("ADDON_CONTRIBUTION_INVALID", `${entry.id}: create() must return a contribution object`);
				contribution = created;
			} catch (error) {
				const code = (error as { code?: string }).code ?? "ADDON_LOAD_FAILED";
				throw loadFailure(code, `${entry.id}@${entry.version} failed to load: ${String(error)}`);
			}
			const items = contribution.knowledge?.items ?? [];
			assertKnowledgeItems(entry.id, items);
			let module: MinecraftCapabilityModule;
			try {
				module = addonCapabilityModule(entry.id, contribution);
			} catch (error) {
				const code = (error as { code?: string }).code;
				// 我们自己的 CallFailure 原样抛出；第三方坏形状（TypeError 等）统一归为贡献非法。
				if (typeof code === "string") throw error;
				throw loadFailure(
					"ADDON_CONTRIBUTION_INVALID",
					`${entry.id}@${entry.version} contribution rejected: ${String(error)}`,
				);
			}
			modules.push(module);
			if (contribution.client != null) {
				const client = contribution.client;
				extensions.push({
					id: entry.id,
					// install 只是转发注册调用；Client 由 Driver 唯一创建，扩展拿不到它。
					...(client.install == null ? {} : { install: (boot) => client.install?.(boot) }),
					...(client.attach == null ? {} : { attach: (ctx) => client.attach?.(ctx) }),
					// 纯转换钩子：只转发，不建独立 runtime，也不给它写权限。
					...(client.localScreen == null ? {} : { localScreen: (event) => client.localScreen?.(event) ?? null }),
				});
			}
			if (items.length > 0) knowledge.push({ addonId: entry.id, items });
			const definitions = module.definitions;
			const status: AddonStatus = {
				id: entry.id,
				version: entry.version,
				api: ADDON_API_VERSION,
				state: "loaded",
				artifactDigest: entry.artifactDigest,
				evidence: {
					planned: true,
					loaded: true,
					// install 只证明"已装配、待协商"；loaded 不等于服端协商通过。
					protocol: contribution.client?.install != null ? "pending" : "not_required",
					dataReady: false,
				},
				minecraft: [...entry.minecraft],
				serverRequirement: entry.serverRequirement,
				dir: entry.root,
				contributed: {
					actions: definitions.filter((definition) => definition.kind === "action").length,
					queries: definitions.filter((definition) => definition.kind === "query").length,
					knowledgeItems: items.length,
					// ref 的命名空间不必等于 addon id，目录投影只能读这份确切清单。
					refs: definitions.map((definition) => definition.descriptor.ref),
				},
			};
			statuses.push(status);
			logger.info(`loaded ${entry.version}`, {
				artifactDigest: entry.artifactDigest,
				actions: status.contributed.actions,
				queries: status.contributed.queries,
			});
		}
	} catch (error) {
		// 主错误原样抛出；清理异常挂在同一错误上供诊断，不覆盖失败原因。
		try {
			await releaseAll();
		} catch (cleanup) {
			const errors = cleanup instanceof AggregateError ? [...cleanup.errors] : [cleanup];
			Object.assign(error as object, { cleanupErrors: errors });
		}
		throw error;
	}
	return { modules, extensions, knowledge, statuses, close: releaseAll };
}
