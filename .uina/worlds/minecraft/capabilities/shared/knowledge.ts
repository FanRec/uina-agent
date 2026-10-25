/** 知识可用性的唯一判定：数据版本来自服务端握手，没有连接就没有配方，只能如实失败。 */
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import { fail } from "./targets.js";

export interface KnowledgeDeps {
	knowledge: () => RegistryKnowledge | null;
}

export function requireKnowledge(deps: KnowledgeDeps): RegistryKnowledge {
	const knowledge = deps.knowledge();
	if (knowledge == null) {
		fail("WRONG_STATE", "game knowledge is not available yet", {
			hint: "item/recipe/craft/smelt need a live connection: the data version comes from the server handshake",
			recoverable: true,
		});
	}
	return knowledge;
}
