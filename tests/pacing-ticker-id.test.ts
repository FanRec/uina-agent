import { describe, expect, it } from "vitest";
import { createPacingOpportunityId } from "../.uina/worlds/pacing-ticker/src/app.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";

describe("pacing ticker opportunity identity", () => {
	it("generates a unique id for each emission", () => {
		const first = createPacingOpportunityId();
		const second = createPacingOpportunityId();

		expect(first).toMatch(/^pacing-opportunity:[0-9a-f-]{36}$/);
		expect(second).toMatch(/^pacing-opportunity:[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	it("allows opportunities from recreated worlds in one session journal", async () => {
		const store = new MemorySessionStore();
		for (const [order, id] of [createPacingOpportunityId(), createPacingOpportunityId()].entries()) {
			const input = {
				id,
				order: order + 1,
				mode: "followUp" as const,
				text: "[时钟节拍]",
				source: { kind: "runtime" as const, type: "pacing-opportunity", ref: "ticker", origin: "internal" as const, channel: "world" as const },
				receivedAt: new Date().toISOString(),
			};
			await store.appendEvent("queue_enqueued", input);
			await store.appendInput(input);
		}

		expect(store.readRecords().filter((record) => record.kind === "input")).toHaveLength(2);
	});
});
