/**
 * 本连接的地图增量包缓存（driver.md §11.8 地图 bullet 的唯一实现）。
 *
 * 只保存实际收到的 128×128 覆盖：colors 收到的色值 + received 逐格已收标记，
 * 不能用零初始化当完整地图。图标字段缺席保留旧值，明确空列表才清空。
 * 校验矩形/长度后一次提交；错误包不污染其他图。换连接 clear()（重连清空当前覆盖）。
 * 唯一定义来源：docs/proposals/mc/public-api.md §4（ClientMapValue）、modules/driver.md §11.8。
 */

import type { MapIconValue } from "../../contracts/client-facts.js";
import type { ProtocolNotice } from "../mineflayer/protocol.js";

export const MAP_SIZE = 128;
export const MAP_CELLS = MAP_SIZE * MAP_SIZE;

export type MapNotice = Extract<ProtocolNotice, { kind: "map" }>;

/** 单张地图的当前覆盖；colors/received 都是 16384 长、z 行 x 列（index = z*128+x）。 */
export interface MapState {
	scale: number | null;
	locked: boolean | null;
	colors: Uint8Array;
	received: Uint8Array;
	icons: MapIconValue[] | null;
}

export class MapCache {
	private readonly maps = new Map<number, MapState>();

	get size(): number {
		return this.maps.size;
	}

	get(id: number): MapState | null {
		return this.maps.get(id) ?? null;
	}

	clear(): void {
		this.maps.clear();
	}

	/**
	 * 应用一条 map 包。像素矩形/长度不合法时整包丢弃（scale/locked/icons 已先应用，
	 * 与服务端语义一致：图标与矩形是两个独立部分）。
	 */
	apply(notice: MapNotice): void {
		if (!Number.isSafeInteger(notice.id) || notice.id < 0) return;
		let state = this.maps.get(notice.id);
		if (state == null) {
			state = {
				scale: null,
				locked: null,
				colors: new Uint8Array(MAP_CELLS),
				received: new Uint8Array(MAP_CELLS),
				icons: null,
			};
			this.maps.set(notice.id, state);
		}
		if (typeof notice.scale === "number") state.scale = notice.scale;
		if (typeof notice.locked === "boolean") state.locked = notice.locked;
		if (notice.icons !== undefined) state.icons = notice.icons;
		const { columns, rows, x, y, data } = notice;
		if (columns === 0) return;
		if (
			!Number.isSafeInteger(columns) ||
			columns < 0 ||
			columns + (x ?? 0) > MAP_SIZE ||
			typeof rows !== "number" ||
			rows < 0 ||
			rows + (y ?? 0) > MAP_SIZE ||
			typeof x !== "number" ||
			typeof y !== "number" ||
			x < 0 ||
			y < 0 ||
			!(data instanceof Uint8Array) ||
			data.length !== columns * rows
		)
			return;
		// 线上 data 是列主序：data[col * rows + row] 对应地图像素 (x+col, y+row)。
		for (let col = 0; col < columns; col++) {
			for (let row = 0; row < rows; row++) {
				const index = (y + row) * MAP_SIZE + (x + col);
				state.colors[index] = data[col * rows + row];
				state.received[index] = 1;
			}
		}
	}
}
