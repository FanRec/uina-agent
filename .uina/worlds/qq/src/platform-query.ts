import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldCancelled, worldFailed } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";

export class QueryError extends Error {
	constructor(
		readonly reason: string,
		message: string,
	) {
		super(message);
	}
}

export function assertQueryActive(deps: QqAppDeps, signal?: AbortSignal): void {
	signal?.throwIfAborted();
	deps.signal?.throwIfAborted();
}

export function assertPlatformIdentity(deps: QqAppDeps): void {
	const connection = deps.transport.snapshot?.();
	if (connection && !connection.connected) throw new QueryError("connection_unavailable", "QQ 当前连接不可用。");
	if (connection && (!connection.identityVerified || connection.selfId !== deps.selfId))
		throw new QueryError("identity_unverified", "当前连接身份未通过绑定账号核验。");
}

export async function queryPlatform(
	deps: QqAppDeps,
	action: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	assertQueryActive(deps, signal);
	assertPlatformIdentity(deps);
	const outcome = await deps.transport.call(action, params, signal);
	assertQueryActive(deps, signal);
	assertPlatformIdentity(deps);
	if (outcome.status !== "ok") {
		let reason = "platform_query_failed";
		if (outcome.kind === "timeout") reason = "query_timeout";
		else if (outcome.kind === "not_connected") reason = "connection_unavailable";
		else if (outcome.kind === "rejected") reason = "platform_denied";
		throw new QueryError(reason, `${action} 查询失败（${outcome.kind}）。`);
	}
	return outcome.data;
}

export function queryFailure(deps: QqAppDeps, error: unknown, signal?: AbortSignal): ToolExecutionResult {
	if (signal?.aborted || deps.signal?.aborted)
		return worldCancelled("QQ 查询已取消。", { reason: deps.signal?.aborted ? "world_stopped" : "cancelled" });
	return error instanceof QueryError
		? worldFailed(error.message, { reason: error.reason })
		: worldFailed("QQ 查询未能完成。", { reason: "query_failed" });
}
