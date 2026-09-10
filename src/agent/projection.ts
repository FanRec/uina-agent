import type { ChatMsg } from "../core/types.js";
import { convertToLlm } from "./context.js";
import { projectAgentHistory } from "../session/recovery.js";
import type { SessionEntry } from "../session/types.js";

/** Projects the ordered journal into the effective provider history. A
 * compaction replaces only model-visible history; the journal itself remains
 * intact. Lives in agent/ because it is an agent projection rule, not a
 * session storage concern (session must not depend on agent). */
export function projectModelHistory(entries: readonly SessionEntry[]): ChatMsg[] {
	return convertToLlm(projectAgentHistory(entries));
}
