/**
 * map@1：携带地图的当前切面（K6 地图查询）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §map。
 * 读取材料归 World（world.md §8.6）：本文件只声明目录与输入校验，
 * 不带 reader——map 属 World 特判派发（同 events/places），因为 image=true
 * 需要 sample 之后的异步编码。不可等待、非 feedback：version=null，
 * 需要新画面时显式重新查询，不为 PNG 缓存建响应式依赖图。
 */

import type { QuerySpec } from "../shared/query.js";

const mapQuery: QuerySpec = {
	descriptor: {
		ref: "map@1",
		summary:
			"Current cut of a carried filled_map: pixel coverage counts, icons and optional same-cut 512x512 PNG; not waitable — re-query for a new cut",
		input: {
			type: "object",
			properties: {
				id: { type: "integer", minimum: 0 },
				image: { type: "boolean" },
			},
			additionalProperties: false,
		},
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: {},
				output: {
					value: {
						id: 3,
						scale: 0,
						locked: false,
						center: null,
						dimension: null,
						icons: [{ type: "player", pixel: { x: 64, z: 64 }, direction: 0, label: null }],
						receivedPixels: 8448,
						totalPixels: 16384,
						paintedPixels: 6271,
						image: {
							path: "/data/exports/images/9f2b….png",
							sha256: "9f2b…",
							bytes: 12840,
							mimeType: "image/png",
							width: 512,
							height: 512,
						},
					},
				},
			},
			{ input: { image: false }, output: { value: { id: 3, receivedPixels: 8448, paintedPixels: 6271, image: null } } },
		],
	},
};

export function mapQueries(): QuerySpec[] {
	return [mapQuery];
}
