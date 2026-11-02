/** container.last 的声明；历史读取与存储归 World。 */

import type { QuerySpec } from "../shared/query.js";
import { GRID_POS_SCHEMA } from "../shared/schema.js";

export const containerLastQuery: QuerySpec = {
	descriptor: {
		ref: "container.last@1",
		summary: "Last actually observed container contents in this world revision; historical, never current inventory",
		input: { type: "object", properties: { at: GRID_POS_SCHEMA }, required: ["at"], additionalProperties: false },
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{ input: { at: { x: 1, y: 64, z: 1 } }, output: { value: { found: false }, source: "history", cursor: null } },
		],
	},
};
