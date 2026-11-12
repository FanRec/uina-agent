import { describe, expect, test } from "vitest";
import { assignVantageZones, boxVantages } from "../../.uina/worlds/minecraft/capabilities/actions/build.js";
import { BLOCK_REACH, EYE_HEIGHT } from "../../.uina/worlds/minecraft/capabilities/shared/reach.js";
import type { Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";

const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe("boxVantages：全盒站位候选", () => {
	test("9 个候选：四侧 pad1/pad2 在前，盒中心最后", () => {
		const box = { min: at(0, 200, 0), max: at(4, 204, 4) };
		const vantages = boxVantages(box, 200);
		// 中心是唯一"进去可能出不来"的站位（1×1 内室），只在外面都够不着时才用。
		expect(vantages.at(-1)).toEqual(at(2, 200, 2));
		expect(vantages).toHaveLength(9);
		// 前 8 个 pad 候选都在盒外。
		for (const v of vantages.slice(0, -1)) {
			const inside = v.x >= 0 && v.x <= 4 && v.z >= 0 && v.z <= 4;
			expect(inside).toBe(false);
		}
	});
});

describe("assignVantageZones：站位分区", () => {
	test("13 格长墙：中心组覆盖中段，两端落 pad 组（旧实现只试首站位必失败）", () => {
		const box = { min: at(0, 200, 0), max: at(12, 201, 0) };
		const cells = [];
		for (let x = 0; x <= 12; x++) cells.push({ at: at(x, 200, 0) });
		const { groups, orphans } = assignVantageZones(cells, boxVantages(box, 200));
		expect(orphans).toEqual([]);
		// 至少 3 组：中心 + 两端 pad。
		expect(groups.length).toBeGreaterThanOrEqual(3);
		const served = groups.flatMap((group) => group.cells.map((cell) => cell.at.x)).sort((a, b) => a - b);
		expect(served).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});

	test("候选序生效：外面够得着的格归 pad 站位，不为它走进盒中心", () => {
		const box = { min: at(0, 200, 0), max: at(4, 204, 4) };
		const center = { at: at(2, 200, 2) }; // 盒中心正上
		const { groups } = assignVantageZones([center], boxVantages(box, 200));
		expect(groups).toHaveLength(1);
		expect(groups[0]!.vantage).not.toEqual(at(2, 200, 2));
	});

	test("谁也够不着的格进 orphans（如实几何无解）", () => {
		const box = { min: at(0, 200, 0), max: at(2, 200, 2) };
		// 站盒中心眼位 201.62，向上射程到 ~206；207 超程。
		const high = { at: at(1, 207, 1) };
		const { orphans } = assignVantageZones([high], boxVantages(box, 200));
		expect(orphans).toHaveLength(1);
		// 射程算术一致性：站盒中心时该格确实超程。
		const eye = { x: 1.5, y: 200 + EYE_HEIGHT, z: 1.5 };
		const dist = Math.hypot(high.at.x + 0.5 - eye.x, high.at.y + 0.5 - eye.y, high.at.z + 0.5 - eye.z);
		expect(dist).toBeGreaterThan(BLOCK_REACH);
	});
});
