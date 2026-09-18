import { listSessionBranches, listSessionNodes, readSessionBranch, readSessionNode } from "./navigation.js";
import type { RewindRequest, RewindResult, SessionAccess, SessionStore } from "./types.js";

/** Rewind entry point owned by the agent runtime (it knows the run-safety points). */
export type RewindEntry = (
	request: RewindRequest,
	source: string,
	signal?: AbortSignal,
) => Promise<RewindResult>;

/**
 * Composes a SessionAccess from a store plus a rewind entry. Session/agent
 * consumers (host assembly, subagent handles) build their view here instead of
 * the agent loop implementing session navigation itself.
 */
export function createSessionAccess(store: SessionStore, requestRewind?: RewindEntry): SessionAccess {
	// 全部查询直读常驻 state：零拷贝、零重放（journal 解释只发生在 store 的 reducer）。
	const state = store.state;
	const list: SessionAccess["list"] = options => listSessionNodes(state, options);
	const access: SessionAccess = {
		list,
		listBranches: () => listSessionBranches(state),
		readBranch: id => readSessionBranch(state, id),
		read: id => readSessionNode(state, id),
		requestRewind: async (request, source, signal) => {
			if (!requestRewind) throw new Error("未配置回溯入口，回溯不可用");
			return requestRewind(request, source, signal);
		},
	};
	return access;
}
