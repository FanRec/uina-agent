import { QQ_GRANT_NAMES } from "./grants-vocabulary.js";

export type GrantName = (typeof QQ_GRANT_NAMES)[number];

/**
 * 部署授权声明（对应 docs/proposals/qq-world-deployment-grants.schema.json）。
 * 未列入即拒绝；空数组合法；缺 deployment.grants 声明是启动失败，不是空授权。
 */
export interface DeploymentGrants {
	readonly grants: readonly GrantName[];
}

export function parseDeploymentGrants(raw: unknown): { ok: true; grants: DeploymentGrants } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "deployment 必须是对象且包含 grants 数组" };
	}
	const record = raw as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((key) => key !== "grants");
	if (unknownKeys.length > 0) {
		return { ok: false, error: `deployment 含未知字段: ${unknownKeys.join(", ")}` };
	}
	if (!Array.isArray(record.grants)) {
		return { ok: false, error: "deployment.grants 必须是数组；缺少该声明为启动失败" };
	}
	const grants: GrantName[] = [];
	for (const item of record.grants) {
		if (typeof item !== "string" || !QQ_GRANT_NAMES.includes(item as GrantName)) {
			return { ok: false, error: `deployment.grants 含未知名称: ${JSON.stringify(item)}；只允许列明名称，无通配符` };
		}
		if (grants.includes(item as GrantName)) {
			return { ok: false, error: `deployment.grants 重复: ${item}` };
		}
		grants.push(item as GrantName);
	}
	return { ok: true, grants: { grants } };
}

export function hasGrant(grants: DeploymentGrants, name: GrantName): boolean {
	return grants.grants.includes(name);
}
