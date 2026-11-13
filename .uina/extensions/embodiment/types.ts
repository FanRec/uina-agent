/**
 * 具身扩展词汇表。
 *
 * 跨 World ↔ Extension 边界的接缝词汇（BodyEndpoint 族与前缀常量）已单源化到
 * `src/extensions/world-framework/seams.ts`，此处 re-export 以维持既有 import 路径
 * （body-router / index / body 工具均从 `./types.js` 取类型）。
 * 本文件只保留具身扩展**内部**词汇（ExtractedCue）。
 */
export {
	BODY_ENDPOINT_EXPOSED_PREFIX,
	type BodyAffordance,
	type BodyEndpoint,
	type BodyState,
	type BodyType,
	type ExpressiveCueDef,
} from "../../../src/extensions/world-framework/seams.js";

/** 一次轻量表现性线索（来自 Output Interpretation 的 marker 语义事件）。 */
export interface ExtractedCue {
	id: string;
	target?: string;
}
