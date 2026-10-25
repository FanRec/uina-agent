/**
 * events@1 的查询声明。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#events。
 * 读取实现归 World（历史库 + 提交屏障 + 分页游标），这里只发布目录/参数/示例；
 * 声明与实现分处两个模块是有意的：能力面是唯一目录，历史存储是唯一读者。
 */

import type { JsonSchema } from "../../contracts/values.js";
import type { QuerySpec } from "../shared/query.js";

const EVENTS_INPUT: JsonSchema = {
	oneOf: [
		{
			type: "object",
			properties: {
				kinds: {
					type: "array",
					items: { type: "string", enum: ["chat", "damage", "death", "connection"] },
					minItems: 1,
					maxItems: 4,
				},
				after: { type: "string", minLength: 1 },
				limit: { type: "integer", minimum: 1, maximum: 200 },
			},
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { cursor: { type: "string", minLength: 1 } },
			required: ["cursor"],
			additionalProperties: false,
		},
	],
};

export const eventsQuery: QuerySpec = {
	descriptor: {
		ref: "events@1",
		summary:
			"Captured client events (chat/damage/death/connection) in receive order, with an opaque `after` token for incremental reads",
		input: EVENTS_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: { kinds: ["chat"], limit: 20 },
				output: {
					value: {
						events: [
							{
								ref: "ev:boot:12",
								receivedAt: "2026-01-01T00:00:00.000Z",
								dimension: "overworld",
								payload: { kind: "chat", channel: "public", text: "hello", sender: null },
							},
						],
						gaps: [],
						after: "eyJ2IjoxLCJwYXJ0aXRpb24iOi...",
					},
				},
			},
		],
	},
};
