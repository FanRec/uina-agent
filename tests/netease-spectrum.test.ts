import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parsePcmFrame, parseSpectrumLine, SpectrumCapture } from "../.uina/worlds/netease-jukebox/spectrum-capture.js";

class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	killed = false;
	kill(): boolean {
		this.killed = true;
		return true;
	}
	emitPcm(samples: readonly number[]): void {
		const buffer = Buffer.alloc(samples.length * 4);
		samples.forEach((sample, index) => buffer.writeFloatLE(sample, index * 4));
		this.stdout.emit("data", buffer);
	}
}

describe("SpectrumCapture", () => {
	it("parses valid audio frames and rejects invalid frames", () => {
		expect(parseSpectrumLine(JSON.stringify({ bands: [0, 0.5, 1], energy: 0.4, beat: 0.2 }))).toEqual({
			source: "audio",
			bands: [0, 0.5, 1],
			energy: 0.4,
			beat: 0.2,
		});
		expect(parseSpectrumLine("not-json")).toBeNull();
		expect(parseSpectrumLine(JSON.stringify({ bands: [2], energy: 0, beat: 0 }))).toBeNull();
	});

	it("reports silent until a fresh frame is received", () => {
		const capture = new SpectrumCapture({
			spawn: () => {
				throw new Error("not used");
			},
		});
		expect(capture.latest(true).source).toBe("silent");
		capture.acceptLine(JSON.stringify({ bands: [0.1], energy: 0.2, beat: 0 }));
		expect(capture.latest(true)).toMatchObject({ source: "audio", bands: [0.1] });
		expect(capture.latest(false).source).toBe("silent");
	});

	it("produces a bounded 32-band frame from PCM samples", () => {
		const frame = parsePcmFrame(Array.from({ length: 2048 }, (_, index) => Math.sin(index / 8)));
		expect(frame?.bands).toHaveLength(32);
		expect(frame?.bands.every((value) => value >= 0 && value <= 1)).toBe(true);
		expect(frame?.energy).toBeGreaterThan(0);
	});

	it("ignores PCM arriving from a superseded capture child", async () => {
		const children: FakeChild[] = [];
		const capture = new SpectrumCapture({
			spawn: () => {
				const child = new FakeChild();
				children.push(child);
				return child;
			},
		});
		capture.start("https://audio.test/old");
		await Promise.resolve();
		capture.start("https://audio.test/new");
		await Promise.resolve();

		children[0]?.emitPcm(Array.from({ length: 2048 }, () => 1));
		expect(capture.latest(true).source).toBe("silent");
		children[1]?.emitPcm(Array.from({ length: 2048 }, (_, index) => Math.sin(index / 8)));
		expect(capture.latest(true).source).toBe("audio");
		await capture.stop();
	});

	it("stops an active capture when the next track has no analyzable URL", async () => {
		const child = new FakeChild();
		const capture = new SpectrumCapture({ spawn: () => child });
		capture.start("https://audio.test/song");
		await Promise.resolve();
		capture.start("simulated://song");
		await Promise.resolve();

		expect(child.killed).toBe(true);
		expect(capture.latest(true).source).toBe("silent");
	});
});
