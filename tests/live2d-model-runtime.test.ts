import { afterEach, expect, it, vi } from "vitest";
import { connectedRuntime, flush } from "./live2d-model-fixture.js";
import { BodyRouter } from "../.uina/extensions/embodiment/body-router.js";
const context = () => ({ signal: new AbortController().signal });
afterEach(() => vi.useRealTimers());
async function render(runtime: Awaited<ReturnType<typeof connectedRuntime>>["runtime"], duration = 2000) {
	for (let t = 0; t < duration; t += 50) {
		runtime.tick(50);
		await flush();
	}
}
it("uses the same published catalog for cue, status and explicit playback", async () => {
	const f = await connectedRuntime();
	try {
		expect(f.runtime.endpoint.affordance().cues.map((c) => c.id)).toContain("nod");
		const done = f.runtime.executeExpress({ motion: "nod" }, context());
		await flush();
		await render(f.runtime);
		expect(await done).toMatchObject({
			status: "succeeded",
			details: { stages: { lowered: { accepted: expect.any(Number) } } },
		});
		expect(
			f.device.injections.every(
				(r) =>
					new Set((r.data.parameterValues as { id: string }[]).map((v) => v.id)).size ===
					(r.data.parameterValues as unknown[]).length,
			),
		).toBe(true);
	} finally {
		f.client.disconnect();
	}
});
it("draft content is previewable but is not advertised or callable as a daily action", async () => {
	const f = await connectedRuntime(false);
	try {
		expect(f.runtime.endpoint.affordance().cues).toEqual([]);
		expect(await f.runtime.executeExpress({ motion: "nod" }, context())).toMatchObject({
			status: "failed",
			details: { reason: "draft" },
		});
		const done = f.runtime.preview({ motion: "nod", background: false }, context());
		await flush();
		await render(f.runtime);
		expect((await done).status).toBe("succeeded");
	} finally {
		f.client.disconnect();
	}
});
it("does not credit a pending ambient ACK to a later action", async () => {
	const f = await connectedRuntime();
	try {
		f.device.accept = false;
		f.runtime.tick(50);
		const old = f.device.injections[0]!;
		const done = f.runtime.executeExpress({ motion: "nod" }, context());
		await flush();
		f.runtime.tick(350);
		f.device.reply(old.requestID, "InjectParameterDataResponse");
		f.runtime.tick(2000);
		expect(await done).toMatchObject({ status: "unknown", details: { transmission: { accepted: 0 } } });
	} finally {
		f.client.disconnect();
	}
});
it("records missing critical stages even if later inputs were accepted", async () => {
	const f = await connectedRuntime();
	try {
		const done = f.runtime.executeExpress({ motion: "nod" }, context());
		await flush();
		f.runtime.tick(100);
		f.runtime.tick(800);
		f.runtime.tick(300);
		expect(await done).toMatchObject({
			status: "unknown",
			details: { stages: { lowered: { accepted: 0 } }, transmission: { accepted: expect.any(Number) } },
		});
	} finally {
		f.client.disconnect();
	}
});
it("cancellation returns immediately and late ACKs cannot confirm a replacement", async () => {
	const f = await connectedRuntime();
	try {
		f.device.accept = false;
		const abort = new AbortController();
		const first = f.runtime.executeExpress({ motion: "nod" }, { signal: abort.signal });
		await flush();
		f.runtime.tick(100);
		const request = f.device.injections[0]!;
		abort.abort();
		expect((await first).status).toBe("cancelled");
		const second = f.runtime.executeExpress({ motion: "nod" }, context());
		await flush();
		f.runtime.tick(350);
		f.device.reply(request.requestID, "InjectParameterDataResponse");
		f.runtime.tick(2000);
		expect(await second).toMatchObject({ status: "unknown", details: { transmission: { accepted: 0 } } });
	} finally {
		f.client.disconnect();
	}
});
it("pause is authoritative for World, cues and audio, and remains paused on failure", async () => {
	const f = await connectedRuntime();
	try {
		const router = new BodyRouter();
		router.registerEndpoint(f.runtime.endpoint);
		await router.pause("live2d");
		expect(f.runtime.endpoint.state().paused).toBe(true);
		expect(router.dispatchCue("nod")).toBe(false);
		expect(await f.runtime.executeExpress({ motion: "nod" }, context())).toMatchObject({
			details: { reason: "paused" },
		});
		f.runtime.processLevel({ rms: 1 });
		await render(f.runtime, 200);
		expect(f.runtime.director!.frame["mouth.open"]).toBe(0);
		await router.resume("live2d");
		expect(f.runtime.endpoint.state().paused).toBe(false);
	} finally {
		f.client.disconnect();
	}
});
it("a cue received during conflicting ownership reports rejected rather than started", async () => {
	const f = await connectedRuntime();
	try {
		const lease = f.runtime.director!.claim(f.runtime.program!.adapter.resourcesFor(["head.pitch"]), {
			priority: 50,
			reason: "hold",
		});
		f.runtime.endpoint.emitCue("nod");
		await flush();
		expect(f.runtime.diagnostics().lastCue).toMatchObject({ state: "rejected" });
		lease.release();
	} finally {
		f.client.disconnect();
	}
});
it("ordinary profile refresh does not masquerade as a model change", async () => {
	const f = await connectedRuntime();
	try {
		const generation = f.client.getModelGeneration();
		const done = f.runtime.executeExpress({ motion: "nod" }, context());
		await flush();
		vi.spyOn(f.client, "getModelProfile").mockReturnValue({ ...f.profile, physicsState: { updated: true } });
		await render(f.runtime);
		expect((await done).status).toBe("succeeded");
		expect(f.client.getModelGeneration()).toBe(generation);
	} finally {
		f.client.disconnect();
	}
});
it("flip stop waits for restoration and prevents a new action from writing during cleanup", async () => {
	vi.useFakeTimers();
	const f = await connectedRuntime();
	try {
		const flip = f.runtime.executeFlip(context());
		await flush();
		const stopped = f.runtime.safeStop();
		await flush();
		expect(await f.runtime.executeExpress({ motion: "nod" }, context())).toMatchObject({
			details: { reason: "paused" },
		});
		await vi.advanceTimersByTimeAsync(1000);
		await stopped;
		expect(await flip).toMatchObject({ status: "cancelled", details: { restoration: "confirmed" } });
		const moves = f.device.requests.filter((r) => r.messageType === "MoveModelRequest");
		expect(moves.at(-1)!.data).toMatchObject({ positionY: 0, rotation: 0 });
	} finally {
		f.client.disconnect();
	}
});
it("same-model refresh during flip still restores, while a real generation change does not write old position", async () => {
	vi.useFakeTimers();
	const f = await connectedRuntime();
	try {
		const done = f.runtime.executeFlip(context());
		await flush();
		vi.spyOn(f.client, "getModelProfile").mockReturnValue({ ...f.profile });
		await vi.advanceTimersByTimeAsync(2000);
		expect((await done).status).toBe("succeeded");
	} finally {
		f.client.disconnect();
	}
});
it("a costume cancelled in the claim-to-send gap never sends a hotkey", async () => {
	const f = await connectedRuntime();
	try {
		f.pkg.costumes = [{ id: "hat", description: "hat", hotkeyID: "hat", resources: ["output:hat"] }];
		vi.spyOn(f.client, "getAvailableHotkeys").mockReturnValue([{ name: "hat", hotkeyID: "hat" }]);
		const abort = new AbortController(),
			claim = f.runtime.director!.claim.bind(f.runtime.director!);
		vi.spyOn(f.runtime.director!, "claim").mockImplementation((...args) => {
			const lease = claim(...args);
			queueMicrotask(() => abort.abort());
			return lease;
		});
		expect((await f.runtime.executeCostume("hat", { signal: abort.signal })).status).toBe("cancelled");
		expect(f.device.requests.some((r) => r.messageType === "HotkeyTriggerRequest")).toBe(false);
	} finally {
		f.client.disconnect();
	}
});
