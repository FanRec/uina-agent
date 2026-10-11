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
] as const;

/**
 * 一次调用所需的 grant；返回 null 表示不需要平台授权（本地事实查询/诊断）。
 * grant=false 拒绝；unknown（平台映射未核实）不是拒绝，由动作层另行处理。
 */
export function requiredGrant(action: string, params: Record<string, unknown>): import("./grants.js").GrantName | null {
	// 消费积木（§4）：本地事实消费不需要 grant；触及平台读取（展开/抓取）需要 observation。
	if (action === "inbox") return params.push !== undefined ? "attention.manage" : null;
	if (action === "read") return params.includeMedia === true ? "observation" : null;
	if (action === "browse") {
		return params.contentTarget !== undefined || params.includeMedia === true ? "observation" : null;
	}
	// 行动积木（§4.5~§4.9）：复用旧链路的 grant 语义。
	if (action === "send") return "messaging";
	if (action === "interact") return params.action === "retract" ? "messages.retract" : "interaction";
	if (action === "remind") return params.action === undefined || params.action === "list" ? null : "follow_up.manage";
	if (action === "requests") return params.action === "respond" ? "requests.respond" : "observation";
	if (action === "profile") {
		return params.action === undefined || params.action === "get" ? "observation" : "profile.modify";
	}
	return null; // skip / 本地 browse：纯本地消费决策
}
