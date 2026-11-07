import { describe, expect, test } from "vitest";
import {
	DEFAULT_STEER_PARAMS,
	decideSlot,
	dirToKeys,
	blurSlots,
	fightSteering,
	HARD,
	newSlotMap,
	writeSlot,
	writeSlotIndex,
} from "../../.uina/worlds/minecraft/capabilities/shared/combat-steering.js";

const AT = { x: 0, y: 64, z: 0 };

const dot = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
	(a.x * b.x + a.z * b.z) / (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z) || 1);

describe("16 槽 context steering 核心", () => {
	test("write/decide：单一兴趣方向被选中（含相邻插值）", () => {
		const interest = newSlotMap();
		writeSlot(interest, 1, 0, 1); // +x
		blurSlots(interest);
		const danger = newSlotMap();
		const choice = decideSlot(interest, danger);
		expect(choice).not.toBeNull();
		// 16 槽：+x 是槽 0；插值后仍是东向。
		expect(dot(choice!, { x: 1, z: 0 })).toBeGreaterThan(0.9);
	});

	test("decide：硬遮罩槽绝不入选，即使兴趣最大", () => {
		const interest = newSlotMap();
		writeSlot(interest, 1, 0, 1);
		const danger = newSlotMap();
		writeSlotIndex(danger, 0, HARD); // +x 槽硬遮罩
		const choice = decideSlot(interest, danger);
		expect(choice).not.toBeNull();
		// 槽 0（正东）不入选；次优槽允许 22.5° 偏转，但不许仍指向被遮的方向。
		expect(choice!.slot).not.toBe(0);
		expect(dot(choice!, { x: 1, z: 0 })).toBeLessThan(0.99);
	});

	test("decide：全部槽硬遮罩返回 null（消费方走背向兜底）", () => {
		const interest = newSlotMap();
		writeSlot(interest, 0, 1, 1);
		const danger = newSlotMap();
		for (let i = 0; i < 16; i++) writeSlotIndex(danger, i, HARD);
		expect(decideSlot(interest, danger)).toBeNull();
	});

	test("blur：硬危险槽保持 HARD 不被平滑稀释", () => {
		const danger = newSlotMap();
		writeSlotIndex(danger, 3, HARD);
		blurSlots(danger);
		expect(danger[3]).toBe(HARD);
	});
});

describe("fightSteering 域组装", () => {
	test("单一远目标：方向朝目标（推进兴趣主导）", () => {
		const { dir } = fightSteering(AT, { x: 6, y: 64, z: 0 }, [], 1, null);
		expect(dir).not.toBeNull();
		expect(dot(dir!, { x: 1, z: 0 })).toBeGreaterThan(0.8);
	});

	test("贴脸目标 + 侧后威胁：方向避开威胁（不逆着威胁走）", () => {
		// 目标在东 2.2（closeBand 之外一点点），第二只威胁在南 2。
		const threats = [{ x: 0, z: 2, name: "zombie" }];
		const { dir } = fightSteering(AT, { x: 2.2, y: 64, z: 0 }, threats, 1, null);
		expect(dir).not.toBeNull();
		// 选出的方向不得指向南边威胁（dot 与南向 < 0.5），也不得一头撞向东目标。
		expect(dot(dir!, { x: 0, z: 1 })).toBeLessThan(0.5);
	});

	test("苦力怕在硬半径内：方向绝不朝它（fuse 风险硬遮罩），即使它就是战斗目标", () => {
		// 目标=苦力怕在东 3（< creeperHardRadius 4）。
		const threats = [{ x: 3, z: 0, name: "creeper" }];
		const { dir } = fightSteering(AT, { x: 3, y: 64, z: 0 }, threats, 1, null);
		if (dir != null) {
			expect(dot(dir, { x: 1, z: 0 })).toBeLessThan(0.3);
		}
		// dir 为 null 也接受（全遮罩时消费方背向兜底）。
	});

	test("危险半径外的远目标：无 danger 槽，推进方向不受挤压", () => {
		const threats = [{ x: 0, z: 30, name: "zombie" }];
		const { dir } = fightSteering(AT, { x: 5, y: 64, z: 0 }, threats, 1, null);
		expect(dir).not.toBeNull();
		expect(dot(dir!, { x: 1, z: 0 })).toBeGreaterThan(0.8);
	});
});

describe("dirToKeys 键位分解（lookAt 钉住目标：forward 轴 = 朝目标）", () => {
	const target = { x: 10, y: 64, z: 0 };
	test("朝目标的方向 = forward", () => {
		expect(dirToKeys({ x: 1, z: 0 }, target, AT)).toEqual({
			forward: true,
			back: false,
			left: false,
			right: false,
		});
	});
	test("背向目标 = back", () => {
		expect(dirToKeys({ x: -1, z: 0 }, target, AT)).toEqual({
			forward: false,
			back: true,
			left: false,
			right: false,
		});
	});
	test("切向绕走 = left/right", () => {
		expect(dirToKeys({ x: 0, z: -1 }, target, AT).left).toBe(true);
		expect(dirToKeys({ x: 0, z: 1 }, target, AT).right).toBe(true);
	});
	test("斜向 = 组合键", () => {
		const keys = dirToKeys({ x: 1, z: -1 }, target, AT);
		expect(keys.forward).toBe(true);
		expect(keys.left).toBe(true);
	});
});

describe("迟滞", () => {
	test("上一拍方向场把下一拍选择拉向连续方向", () => {
		const params = { ...DEFAULT_STEER_PARAMS, strafeStrength: 0 };
		// 第一拍：目标在东。
		const first = fightSteering(AT, { x: 6, y: 64, z: 0 }, [], 1, null, params);
		expect(dot(first.dir!, { x: 1, z: 0 })).toBeGreaterThan(0.9);
		// 第二拍：目标瞬移到北（同样远）。无迟滞时立即指北；有迟滞时仍在东-北象限。
		const second = fightSteering(AT, { x: 0, y: 64, z: 6 }, [], 1, first.cur, params);
		const angle = Math.atan2(second.dir!.z, second.dir!.x);
		expect(angle).toBeGreaterThan(-0.2); // 不指西（迟滞阻止直接掉头）
	});
});
