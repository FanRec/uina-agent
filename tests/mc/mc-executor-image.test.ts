import { describe, expect, test } from "vitest";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";

/**
 * G11 observe 图片出口（executor.md §2.1.1）：observe(map@1) 值里的 ImageFileRef
 * 经 read_image 变成 ToolExecutionResult.images；读取失败给原因不冒充图片；
 * mc.read（程序路径）不经过这里，run/delivery 不带图。
 */

interface RpcCall {
	method: string;
	payload: Record<string, unknown>;
}

function makeFacade(rpc: (call: RpcCall) => unknown) {
	const executor = {
		rpc: async (method: string, payload: Record<string, unknown>) => rpc({ method, payload }),
	} as unknown as MinecraftExecutor;
	const ctx = { signal: new AbortController().signal } as never;
	return new MinecraftFacade(executor, ctx, {});
}

const imageRef = {
	path: "/data/exports/images/abc.png",
	sha256: "abc123",
	bytes: 12,
	mimeType: "image/png",
};

function observation(withImage: boolean) {
	return {
		value: {
			id: 3,
			scale: 0,
			locked: false,
			center: null,
			dimension: null,
			icons: [],
			receivedPixels: 42,
			totalPixels: 16384,
			paintedPixels: 40,
			image: withImage ? imageRef : null,
		},
		observedAt: "2026-01-01T00:00:00.000Z",
		source: "server",
		coverage: "partial",
		unknown: [],
		cursor: null,
	};
}

describe("facade observe 图片出口", () => {
	test("image ref → read_image → ToolExecutionResult.images 带 alt 图例", async () => {
		const calls: RpcCall[] = [];
		const facade = makeFacade(({ method, payload }) => {
			calls.push({ method, payload });
			if (method === "observe") return observation(true);
			if (method === "read_image") return { mimeType: "image/png", data: "aGVsbG8=" };
			throw new Error(`unexpected rpc ${method}`);
		});
		const result = await facade.execute(
			"observe",
			{ selector: "map@1", input: { id: 3 } },
			new AbortController().signal,
		);
		expect(result.status).toBe("succeeded");
		expect(result.images).toHaveLength(1);
		expect(result.images![0]).toMatchObject({ type: "image", mimeType: "image/png", data: "aGVsbG8=" });
		expect(result.images![0]!.alt).toContain("map 3");
		expect(result.images![0]!.alt).toContain("42/16384");
		expect(calls.map((call) => call.method)).toEqual(["observe", "read_image"]);
		expect(calls[1]!.payload).toMatchObject({ path: imageRef.path, sha256: imageRef.sha256, bytes: imageRef.bytes });
	});

	test("image=false（值里无 ref）不产生 read_image", async () => {
		const calls: RpcCall[] = [];
		const facade = makeFacade(({ method }) => {
			calls.push({ method, payload: {} });
			if (method === "observe") return observation(false);
			throw new Error(`unexpected rpc ${method}`);
		});
		const result = await facade.execute("observe", { selector: "map@1" }, new AbortController().signal);
		expect(result.images).toBeUndefined();
		expect(calls.map((call) => call.method)).toEqual(["observe"]);
	});

	test("read_image 失败：元数据保留，imageDelivery 给原因与原路径，不冒充图片", async () => {
		const facade = makeFacade(({ method }) => {
			if (method === "observe") return observation(true);
			throw new Error("image file does not exist");
		});
		const result = await facade.execute("observe", { selector: "map@1" }, new AbortController().signal);
		expect(result.status).toBe("succeeded");
		expect(result.images).toBeUndefined();
		const details = result.details as { imageDelivery?: { delivered: boolean; path: string; reason: string } };
		expect(details.imageDelivery).toMatchObject({ delivered: false, path: imageRef.path });
		expect(details.imageDelivery!.reason).toContain("does not exist");
		const value = JSON.parse(result.result) as { value: { image: unknown } };
		expect(value.value.image).toEqual(imageRef); // 元数据仍在 JSON 里
	});
});
