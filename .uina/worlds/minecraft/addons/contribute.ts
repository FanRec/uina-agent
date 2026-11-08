/**
 * Addon 贡献 → 能力模块：与内置能力走**同一次** Catalog 装配。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3。规则：
 * - 外部能力只使用公共契约（NativeCallable / QueryDescriptor + QueryReader），
 *   不引入第二套 invoke/query 注册表；
 * - ref 必须命名空间化（`<namespace>.<name>@<version>`，建议用 addon id 作 namespace），
 *   与内置 ref 共用唯一性校验——重名在 Catalog 装配处显式失败，不静默覆盖；
 * - 坏 descriptor / 坏 schema 在 `CapabilityCatalog.create` 处失败，不静默覆盖。
 */

import type { CapabilityDefinition, MinecraftCapabilityModule } from "../capabilities/catalog.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type { JsonValue } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { AddonContribution } from "./sdk.js";

function contributionFailure(code: string, message: string): Error {
	return callFailure({
		code,
		source: "environment",
		message,
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

/**
 * ref 必须带命名空间前缀：`<namespace>.<name>@<version>`。
 * 只校验"有命名空间"，不把前缀绑死成 addon id（规格示例 `example.machine@1` 即此形）。
 * 跨包/与内置重名由 Catalog 的唯一性校验兜底。
 */
const NAMESPACED_REF = /^[^@\s]+\.[^@\s]+@[^@\s]+$/;

function assertAddonRef(addonId: string, ref: string, kind: string): void {
	if (!NAMESPACED_REF.test(ref))
		throw contributionFailure(
			"ADDON_REF_INVALID",
			`${addonId}: ${kind} ref ${JSON.stringify(ref)} must be namespaced as "<namespace>.<name>@<version>"`,
		);
}

/** 把 addon 贡献转成与内置模块同形的定义列表；顺序无关（Catalog 按 ref 建索引）。 */
export function addonCapabilityModule(id: string, contribution: AddonContribution): MinecraftCapabilityModule {
	const definitions: CapabilityDefinition[] = [];
	for (const action of contribution.actions ?? []) {
		assertAddonRef(id, action.descriptor.ref, "action");
		if (action.descriptor.access !== "act")
			throw contributionFailure(
				"ADDON_DESCRIPTOR_INVALID",
				`${id}: action ${action.descriptor.ref} must declare access "act"`,
			);
		definitions.push({
			kind: "action",
			descriptor: action.descriptor,
			bind: () => action.invoke,
		});
	}
	for (const query of contribution.queries ?? []) {
		assertAddonRef(id, query.descriptor.ref, "query");
		if (query.descriptor.access !== "read")
			throw contributionFailure(
				"ADDON_DESCRIPTOR_INVALID",
				`${id}: query ${query.descriptor.ref} must declare access "read"`,
			);
		if (query.reader == null || (query.reader.kind !== "current" && query.reader.kind !== "static"))
			throw contributionFailure(
				"ADDON_DESCRIPTOR_INVALID",
				`${id}: query ${query.descriptor.ref} needs a current or static reader`,
			);
		definitions.push({
			kind: "query",
			descriptor: query.descriptor,
			bind: () => query.reader,
		});
	}
	return { id: `addon:${id}`, definitions };
}

/**
 * 测试/开发注入用：把可信 NativeCallable 包成模块（仍进同一次 Catalog 装配）。
 * 不是第二个执行入口——它产出的就是 MinecraftCapabilityModule。
 */
export function callableModule(
	id: string,
	callables: readonly NativeCallable<JsonValue, JsonValue>[],
): MinecraftCapabilityModule {
	return {
		id: `injected:${id}`,
		definitions: callables.map((callable) => ({
			kind: "action" as const,
			descriptor: callable.descriptor,
			bind: () => callable.invoke,
		})),
	};
}
