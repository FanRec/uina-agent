import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { SubjectHarness } from "./harness/core/subject-harness.js";
import {
	PROMPT_SNAPSHOT_ENTRY_TYPE,
	isPromptSnapshotData,
	listPromptSnapshots,
	promptSnapshotFingerprint,
} from "../src/session/prompt-snapshots.js";

const injections = [
	{
		extension: "builtin:event-frames",
		kind: "systemPrompt" as const,
		chars: 12,
		preview: "[event frame]",
	},
	{
		extension: "builtin:world-framework",
		kind: "messages" as const,
		messageCount: 1,
		chars: 8,
		preview: "[memory]",
	},
];

describe("prompt snapshots", () => {
	it("fingerprints the effective prompt and ordered provenance", () => {
		const first = promptSnapshotFingerprint("BASE", injections);
		expect(first).toBe(promptSnapshotFingerprint("BASE", injections));
		expect(first).not.toBe(promptSnapshotFingerprint("CHANGED", injections));
		expect(first).not.toBe(promptSnapshotFingerprint("BASE", [...injections].reverse()));
	});

	it("accepts only the persisted prompt snapshot shape", () => {
		const data = {
			turnNumber: 3,
			fingerprint: promptSnapshotFingerprint("BASE", injections),
			systemPrompt: "BASE",
			injections,
		};
		expect(isPromptSnapshotData(data)).toBe(true);
		expect(isPromptSnapshotData({ ...data, systemPrompt: 42 })).toBe(false);
	});

	it("lists only prompt snapshots and preserves journal sequence", () => {
		const auxiliary = [
			{
				kind: "custom_entry" as const,
				id: "other",
				seq: 2,
				timestamp: "2026-10-04T00:00:00.000Z",
				customType: "other",
				data: {},
			},
			{
				kind: "custom_entry" as const,
				id: "prompt",
				seq: 1,
				timestamp: "2026-10-04T00:00:00.000Z",
				customType: PROMPT_SNAPSHOT_ENTRY_TYPE,
				data: {
					turnNumber: 1,
					fingerprint: promptSnapshotFingerprint("BASE", injections),
					systemPrompt: "BASE",
					injections,
				},
			},
		];
		expect(listPromptSnapshots(auxiliary).map((entry) => entry.id)).toEqual(["prompt"]);
	});
	it("Subject 只在有效提示词构成变化时保存快照", async () => {
		const store = new MemorySessionStore();
		let prompt = "BASE";
		const harness = SubjectHarness.create({
			store,
			runtimeHooks: {
				...NO_RUNTIME_HOOKS,
				turn: {
					...NO_RUNTIME_HOOKS.turn,
					prepare: async () => ({ systemPrompt: prompt, injections: [] }),
				},
			},
		});
		await harness.run("one");
		await harness.run("two");
		prompt = "CHANGED";
		await harness.run("three");
		const snapshots = listPromptSnapshots(store.state.auxiliary);
		expect(snapshots).toHaveLength(2);
		expect(snapshots.map((entry) => entry.systemPrompt)).toEqual(["BASE", "CHANGED"]);
	});
});
