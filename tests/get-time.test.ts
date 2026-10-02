import { describe, expect, it } from "vitest";
import getTime from "../src/extensions/runtime-tools/get-time/index.js";

describe("get_time", () => {
	it("returns stable machine-readable time facts", async () => {
		const result = await getTime.run({});
		const value = JSON.parse(result.result);
		expect(result.status).toBe("succeeded");
		expect(value.iso).toMatch(/T/);
		expect(value.utc).toMatch(/GMT$/);
		expect(typeof value.timeZone).toBe("string");
		expect(typeof value.display).toBe("string");
	});
});
