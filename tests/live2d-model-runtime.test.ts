import { afterEach, expect, it, vi } from "vitest";
import { VTSClient, type WebSocketLike } from "../.uina/worlds/live2d/vts-client.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { independentModelFixture } from "./live2d-model-fixture.js";
import { MOTION_NAMES, namedMotion } from "../.uina/worlds/live2d/motion-library.js";
import type { ModelProfile } from "../.uina/worlds/live2d/model-profile.js";
import { hashContent } from "../.uina/worlds/live2d/model-profile.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Device implements WebSocketLike {
	readyState = 1;
	onopen: WebSocketLike["onopen"] = null;
	onclose: WebSocketLike["onclose"] = null;
	onmessage: WebSocketLike["onmessage"] = null;
	onerror: WebSocketLike["onerror"] = null;
	injections: { id: string; value: number }[][] = [];
	accept = true;
	constructor(readonly profile: ModelProfile) {}
	send(raw: string, cb?: (err?: Error) => void): void {
		const request = JSON.parse(raw);
		cb?.();
		let data: unknown = {};
		if (request.messageType === "AuthenticationRequest") data = { authenticated: true };
		if (request.messageType === "CurrentModelRequest") data = { modelLoaded: true, modelID: this.profile.modelID };
		if (request.messageType === "GetCurrentModelPhysicsRequest")
			data = { modelID: this.profile.modelID, modelHasPhysics: false, physicsSwitchedOn: false };
		if (request.messageType === "APIStateRequest") data = { vTubeStudioVersion: "fixture" };
		if (request.messageType === "InputParameterListRequest") data = { defaultParameters: this.profile.inputs };
		if (request.messageType === "Live2DParameterListRequest")
			data = { parameters: Object.entries(this.profile.parameterRanges!).map(([name, range]) => ({ name, ...range })) };
		if (request.messageType === "InjectParameterDataRequest") {
			this.injections.push(request.data.parameterValues);
			if (!this.accept) return;
		}
		this.onmessage?.({
			data: JSON.stringify({
				requestID: request.requestID,
				messageType: request.messageType.replace("Request", "Response"),
				data,
			}),
		});
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.({});
	}
}
const flush = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
	vi.useRealTimers();
});

it("a model with only arbitrary output IDs becomes ready and receives authored motion through the full production chain", async () => {
	const profile = independentModelFixture(),
		socket = new Device(profile);
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => socket,
		profileLoader: async () => profile,
	});
	const runtime = new Live2DRuntime({ vtsClient: client });
	try {
		client.connect();
		socket.onopen?.({});
		await flush();
		expect(client.isConnected()).toBe(true);
		const adapter = runtime.companion.getAdapter();
		expect(adapter).toBeDefined();
		expect(runtime.companion.getAdapter()).toBe(adapter);
		expect(runtime.endpoint.supportsCue("nod")).toBe(true);
		const pending = runtime.executeExpress({ head: "turn_left", beats: [{ head: "turn_left", hold_ms: 100 }] }, {
			signal: new AbortController().signal,
		} as never);
		await flush();
		runtime.director.compose(40);
		runtime.companion.tick();
		runtime.director.compose(70);
		runtime.companion.tick();
		runtime.director.compose(350);
		runtime.companion.tick();
		const result = await pending;
		expect(result.status).toBe("succeeded");
		expect(result.details).toMatchObject({ verification: "input_accepted" });
		expect(socket.injections.some((frame) => frame.some((p) => p.id === "Drive0" && p.value < 0))).toBe(true);
		expect(client.getInjectionStats().accepted).toBe(socket.injections.length);
	} finally {
		client.disconnect();
	}
});

it("every migrated performance is admitted, advertised, injected and released through the production runtime", async () => {
	const profile = independentModelFixture();
	const socket = new Device(profile);
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => socket,
		profileLoader: async () => profile,
	});
	const runtime = new Live2DRuntime({ vtsClient: client });
	try {
		client.connect();
		socket.onopen?.({});
		await flush();
		for (const name of MOTION_NAMES) {
			expect(runtime.endpoint.affordance().cues.some((cue) => cue.id === name)).toBe(true);
			const before = socket.injections.length;
			const pending = runtime.executeExpress({ motion: name, atomic: true }, {
				signal: new AbortController().signal,
			} as never);
			await flush();
			const durationMs = namedMotion(name).durationMs;
			for (let at = 0; at < durationMs + 350; at += 20) {
				runtime.director.compose(20);
				runtime.companion.tick();
			}
			expect(await pending).toMatchObject({ status: "succeeded", details: { verification: "input_accepted" } });
			expect(socket.injections.length).toBeGreaterThan(before);
			expect(runtime.director.getActiveLeases()).toEqual([]);
		}
	} finally {
		client.disconnect();
	}
});

it("unavailable required axes reject before any leases, while catalog membership alone never grants a cue", async () => {
	const profile = independentModelFixture();
	profile.inputs = [];
	const socket = new Device({ ...profile, inputs: [{ name: "Unrelated", min: 0, max: 1, defaultValue: 0 }] });
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => socket,
		profileLoader: async () => profile,
	});
	const runtime = new Live2DRuntime({ vtsClient: client });
	try {
		client.connect();
		socket.onopen?.({});
		await flush();
		expect(runtime.endpoint.supportsCue("nod")).toBe(false);
		expect(runtime.endpoint.affordance().cues.some((c) => c.id === "nod")).toBe(false);
		const result = await runtime.executeExpress({ head: "nod", atomic: true }, {
			signal: new AbortController().signal,
		} as never);
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({ effectStatus: "not_started" });
		expect(runtime.director.getActiveLeases()).toEqual([]);
		expect(socket.injections).toEqual([]);
	} finally {
		client.disconnect();
	}
});

it("timeline completion without injection evidence is unknown; changing models cancels old trajectories", async () => {
	const profile = independentModelFixture(),
		socket = new Device(profile);
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => socket,
		profileLoader: async () => profile,
	});
	const runtime = new Live2DRuntime({ vtsClient: client });
	try {
		client.connect();
		socket.onopen?.({});
		await flush();
		const pending = runtime.executeExpress({ head: "nod" }, { signal: new AbortController().signal } as never);
		await flush();
		runtime.director.compose(2000);
		expect((await pending).status).toBe("unknown");
		const second = runtime.executeExpress({ head: "nod" }, { signal: new AbortController().signal } as never);
		await flush();
		socket.onmessage?.({ data: JSON.stringify({ messageType: "ModelLoadedEvent", data: {} }) });
		expect(runtime.director.isPlaying()).toBe(false);
		expect((await second).status).toBe("unknown");
		expect(client.getModelProfile()).toBeUndefined();
		expect(runtime.companion.getAdapter()).toBeUndefined();
	} finally {
		client.disconnect();
	}
});

it("same-ID file changes stay blocked across reconnect until a model reload event", async () => {
	vi.useFakeTimers();
	const directory = await mkdtemp(join(tmpdir(), "uina-runtime-fingerprint-"));
	const file = join(directory, "m.vtube.json");
	await writeFile(file, "original");
	let profile = { ...independentModelFixture(), directory, files: [{ path: file, hash: hashContent("original") }] };
	const sockets: Device[] = [];
	const client = new VTSClient({
		token: "fixture",
		profileLoader: async () => profile,
		webSocketFactory: () => {
			const device = new Device(profile);
			sockets.push(device);
			return device;
		},
	});
	try {
		client.connect();
		sockets[0]!.onopen?.({});
		await flush();
		expect(client.isConnected()).toBe(true);
		await writeFile(file, "changed");
		expect(await client.validateModelFiles()).toBe(false);
		expect(client.isConnected()).toBe(false);
		profile = { ...profile, files: [{ path: file, hash: hashContent("changed") }] };
		await vi.advanceTimersByTimeAsync(1000);
		sockets[1]!.onopen?.({});
		await flush();
		expect(client.isConnected()).toBe(false);
		expect(client.getFault()).toContain("等待 VTS 重新加载");
		// Keep the authenticated subscription open while awaiting an explicit reload.
		expect(client.getConnectionStatus()).toMatchObject({ authenticated: true, stage: "等待模型重新加载" });
		sockets[1]!.onmessage?.({ data: JSON.stringify({ messageType: "ModelLoadedEvent", data: {} }) });
		await vi.advanceTimersByTimeAsync(1500);
		sockets[2]!.onopen?.({});
		await flush();
		expect(client.isConnected()).toBe(true);
	} finally {
		client.disconnect();
		await rm(directory, { recursive: true, force: true });
	}
});
