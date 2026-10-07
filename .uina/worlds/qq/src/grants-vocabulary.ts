/**
 * QQ World 授权词表与动作映射（唯一维护点：交互合同 §2 grant 映射表）。
 * 只允许列明名称，未列即拒绝，无通配符/占位能力；写 grant 不隐含读 grant。
 */

export const QQ_GRANT_NAMES = [
	"observation",
	"messaging",
	"interaction",
	"attention.manage",
	"follow_up.manage",
	"requests.respond",
	"profile.modify",
	"messages.retract",
	"messages.mark_read",
	"groups.leave",
	"contacts.remove",
] as const;

/** observe scope 是否属于平台读取（observation grant 覆盖）。 */
export const OBSERVATION_SCOPES = [
	"overview",
	"contacts",
	"groups",
	"conversations",
	"members",
	"conversation",
	"messages",
	"requests",
	"self",
	"expressions",
] as const;

/** 无需 observation 即可查询的本地事实/诊断 scope。 */
export const LOCAL_OBSERVE_SCOPES = [
	"attention",
	"follow_ups",
	"operations",
	"status",
	"capabilities",
] as const;

/** account.operation → 必需 grant。 */
export const ACCOUNT_OPERATION_GRANTS: Record<string, import("./grants.js").GrantName> = {
	respond_request: "requests.respond",
	retract: "messages.retract",
	mark_read: "messages.mark_read",
	leave_group: "groups.leave",
	remove_contact: "contacts.remove",
	set_profile: "profile.modify",
	set_avatar: "profile.modify",
	set_presence: "profile.modify",
	set_group_card: "profile.modify",
};

/** 顶层 action → 必需 grant（observe 的 scope 维度另行判定）。 */
export const ACTION_GRANTS: Record<string, import("./grants.js").GrantName> = {
	speak: "messaging",
	gesture: "interaction",
	attention: "attention.manage",
	follow_up: "follow_up.manage",
};

/**
 * 一次调用所需的 grant；返回 null 表示不需要平台授权（本地事实查询/诊断）。
 * grant=false 拒绝；unknown（平台映射未核实）不是拒绝，由动作层另行处理。
 */
export function requiredGrant(action: string, params: Record<string, unknown>): import("./grants.js").GrantName | null {
	const byAction = ACTION_GRANTS[action];
	if (byAction) return byAction;
	if (action === "account") {
		const operation = typeof params.operation === "string" ? params.operation : "";
		return ACCOUNT_OPERATION_GRANTS[operation] ?? null;
	}
	if (action === "observe") {
		const scope = typeof params.scope === "string" ? params.scope : "";
		if ((OBSERVATION_SCOPES as readonly string[]).includes(scope)) return "observation";
		return null;
	}
	return null;
}
