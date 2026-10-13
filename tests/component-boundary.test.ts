import { describe, expect, it } from "vitest";
import { ComponentBoundary } from "../src/ui/core/component-boundary.js";
import { visibleWidth } from "../src/ui/core/utils.js";

describe("ComponentBoundary", () => {
	it("contains render and input failures and reports each failure once", () => {
		const reports: string[] = [];
		const boundary = new ComponentBoundary((_component, operation) => reports.push(operation));
		const broken = {
			render: () => {
				throw new Error("bad render");
			},
			handleInput: () => {
				throw new Error("bad input");
			},
		};

		const first = boundary.render(broken, 12);
		boundary.render(broken, 12);
		expect(first).toHaveLength(1);
		expect(visibleWidth(first[0]!)).toBeLessThanOrEqual(12);
		expect(boundary.handleInput(broken, "x")).toBe(false);
		expect(reports).toEqual(["render", "input"]);
	});
});
