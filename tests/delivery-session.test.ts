import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { canonicalReplay } from "../src/session/recovery.js";

describe("delivery journal", () => {
	it("reports poisoned storage when append rollback cannot establish durable absence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-delivery-poison-"));
		try {
			const { store } = await openJsonlSession(join(dir, "session.jsonl"));
			vi.spyOn(store["handle"], "write").mockRejectedValueOnce(new Error("write failed"));
			vi.spyOn(store["handle"], "truncate").mockRejectedValueOnce(new Error("rollback failed"));
			await expect(
				store.appendEvent("queue_enqueued", { id: "q", order: 1, mode: "followUp", text: "report" }),
			).rejects.toThrow(/回滚失败/);
			expect(store.failure).toBeInstanceOf(AggregateError);
			expect(store.state.queued.size).toBe(0);
			await expect(
				store.appendEvent("queue_enqueued", { id: "q2", order: 2, mode: "followUp", text: "report" }),
			).rejects.toThrow(/回滚失败/);
			await store.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects incomplete receipt metadata and a changed input binding at commit", async () => {
		const store = new MemorySessionStore();
		const item = {
			id: "q",
			order: 1,
			mode: "followUp" as const,
			text: "report",
			receipt: { key: "k", attempt: "a" },
			receiptNamespace: "ns",
		};
		expect(() => store.appendEvent("queue_enqueued", { ...item, receiptNamespace: undefined })).toThrow(/receipt/);
		await store.appendEvent("queue_enqueued", item);
		expect(() => store.appendInput({ ...item, receiptNamespace: "other" })).toThrow(/receipt/);
		expect(store.state.deliveryCommits.size).toBe(0);
	});
	it("creates v4 durable sessions with stable identity and rejects v3 without modifying it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-delivery-"));
		try {
			const path = join(dir, "session.jsonl");
			const first = await openJsonlSession(path);
			expect(first.snapshot.header.version).toBe(4);
			expect(first.store.session).toBe(first.snapshot.header.id);
			expect(first.store.durability).toBe("durable");
			await first.store.close();
			const second = await openJsonlSession(path);
			expect(second.store.session).toBe(first.store.session);
			await second.store.close();
			const old = JSON.stringify({ ...first.snapshot.header, version: 3 }) + "\n";
			await writeFile(path, old);
			await expect(openJsonlSession(path)).rejects.toThrow(/版本/);
			expect(await readFile(path, "utf8")).toBe(old);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("indexes only canonical commits, keeps the first receipt across rewind, and replays identically", async () => {
		const store = new MemorySessionStore();
		expect(store.durability).toBe("volatile");
		await store.appendMessage({ role: "user", content: "root" }, "root");
		const input = {
			id: "q",
			order: 1,
			mode: "followUp" as const,
			text: "report",
			receipt: { key: "k", attempt: "a" },
			receiptNamespace: "world:test",
		};
		await store.appendEvent("queue_enqueued", input);
		expect(store.state.deliveryCommits.size).toBe(0);
		await store.appendInput(input);
		const receipt = store.state.deliveryCommits.get(JSON.stringify(["world:test", "k"]));
		expect(receipt).toEqual({ namespace: "world:test", key: "k", attempt: "a", record: "q", channel: "input" });
		await store.appendRewind({
			id: "rewind",
			requestId: "r",
			targetId: "root",
			fromId: "q",
			source: "test",
			reason: "back",
		});
		expect(store.state.deliveryCommits.get(JSON.stringify(["world:test", "k"]))).toEqual(receipt);
		await store.appendEvent("queue_enqueued", { ...input, id: "q2", order: 2, receipt: { key: "k", attempt: "b" } });
		await store.appendInput({ ...input, id: "q2", order: 2, receipt: { key: "k", attempt: "b" } });
		expect(store.state.deliveryCommits.get(JSON.stringify(["world:test", "k"]))).toEqual(receipt);
		expect(store.state).toEqual(canonicalReplay(store.readRecords()));
	});
	it("does not acknowledge a recovery-generated tool result or a tag in ordinary content", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-delivery-recovery-"));
		try {
			const path = join(dir, "session.jsonl");
			const { store } = await openJsonlSession(path);
			await store.appendMessage({ role: "user", content: JSON.stringify({ receipt: { key: "fake", attempt: "x" } }) });
			await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "c", name: "probe", args: {} }] });
			await store.appendEvent("tool_started", { callId: "c" });
			await store.appendEvent("tool_finished", { callId: "c", status: "succeeded" });
			await store.close();
			const reopened = await openJsonlSession(path);
			expect(reopened.store.state.deliveryCommits.size).toBe(0);
			await reopened.store.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
