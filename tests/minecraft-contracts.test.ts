import { describe, expect, it } from "vitest";
import {
	CALL_FAILURE_MEANINGS,
	CallFailureError,
	isCallFailure,
	isCallFailureCode,
	isExactRef,
} from "../.uina/worlds/minecraft/contracts/index.js";
import * as contracts from "../.uina/worlds/minecraft/contracts/index.js";

describe("minecraft contracts", () => {
	it("错误码词表覆盖全部登记项且含义非空", () => {
		const codes = Object.keys(CALL_FAILURE_MEANINGS);
		expect(codes.length).toBeGreaterThan(20);
		for (const code of codes)
			expect(CALL_FAILURE_MEANINGS[code as keyof typeof CALL_FAILURE_MEANINGS].length).toBeGreaterThan(0);
	});

	it("CallFailureError 携带领域失败形状", () => {
		const failure = new CallFailureError({
			code: "TARGET_NOT_MET",
			message: "只收集到 19/32",
			dispatch: "sent",
			progress: { summary: "采集中断", measures: [{ name: "collected", value: 19, unit: "items", evidence: [] }] },
			effects: ["e1"],
		});
		expect(failure.code).toBe("TARGET_NOT_MET");
		expect(failure.dispatch).toBe("sent");
		expect(failure.effects).toEqual(["e1"]);
		expect(failure.recoverable).toBe(false);
		expect(isCallFailure(failure)).toBe(true);
		expect(isCallFailure(new Error("普通错误"))).toBe(false);
	});

	it("isExactRef 拒绝缺名、缺版本与多版本号", () => {
		expect(isExactRef("gather.collect@3")).toBe(true);
		expect(isExactRef("@3")).toBe(false);
		expect(isExactRef("name@")).toBe(false);
		expect(isExactRef("name@1@2")).toBe(false);
		expect(isExactRef("name")).toBe(false);
		expect(isExactRef(42)).toBe(false);
	});

	it("isCallFailureCode 只认词表成员，能力私有码不算非法", () => {
		expect(isCallFailureCode("TARGET_NOT_MET")).toBe(true);
		expect(isCallFailureCode("NOT_A_CODE")).toBe(false);
		expect(isCallFailureCode(undefined)).toBe(false);
		// 词表外码允许存在（能力私有领域码），只是不在通用词表内。
		const private_ = new CallFailureError({ code: "craft.unknown_recipe", message: "x" });
		expect(isCallFailure(private_)).toBe(true);
		expect(isCallFailureCode(private_.code)).toBe(false);
	});

	it("contracts 模块导出关键接缝类型不发生运行时丢失", () => {
		// 合同以类型为主；此处钉住关键运行时出口，防止重构时被意外删除。
		expect(typeof contracts.isExactRef).toBe("function");
		expect(typeof contracts.isCallFailure).toBe("function");
		expect(Object.keys(contracts.CALL_FAILURE_MEANINGS).length).toBeGreaterThan(0);
	});
});
