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

/** Every platform read requires observation; writes do not imply reads. */
export function requiredGrants(action: string, params: Record<string, unknown>): import("./grants.js").GrantName[] {
	if (action === "inbox") return params.push !== undefined ? ["observation", "attention.manage"] : ["observation"];
	if (action === "read") return params.includeMedia === true ? ["observation"] : [];
	if (action === "browse")
		return params.contentTarget !== undefined ||
			params.messageRefs !== undefined ||
			params.includeMedia === true ||
			params.source === "platform"
			? ["observation"]
			: [];
	if (action === "send") return ["messaging"];
	if (action === "interact") return [params.action === "retract" ? "messages.retract" : "interaction"];
	if (action === "remind") return params.action === undefined || params.action === "list" ? [] : ["follow_up.manage"];
	if (action === "requests") return [params.action === "respond" ? "requests.respond" : "observation"];
	if (action === "profile")
		return [params.action === undefined || params.action === "get" ? "observation" : "profile.modify"];
	return [];
}
