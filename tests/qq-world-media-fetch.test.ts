import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInboundImages, imageSourcesFromFacts } from "../.uina/worlds/qq/src/media-fetch.js";
import type { MessageFact } from "../.uina/worlds/qq/src/types.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function pngResponse(headers: Record<string, string> = {}): Response {
	return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png", ...headers } });
}

function factWithImage(index: number, url: string | undefined): MessageFact {
	return {
		ref: `qq-message:10001:${index}`,
		conversationRef: "qq-conversation:10001:group:30003",
		senderRef: "qq-user:10001:20002",
		senderDisplayName: "小明",
		direction: "in",
		sequence: index,
		time: "2026-10-07T15:00:00+08:00",
		segments: [
			{
				type: "image",
				mediaRef: `qq-media:10001:${index}`,
				...(url ? { url } : {}),
				fileName: `img-${index}.png`,
				understood: false,
			},
		],
		source: "platform",
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("media-fetch 抓取边界", () => {
	it("单次展开上限：5 张请求只成功 4 张，第 5 张计入失败不静默丢弃", async () => {
		vi.stubGlobal("fetch", async () => pngResponse());
		const sources = imageSourcesFromFacts([1, 2, 3, 4, 5].map((i) => factWithImage(i, "https://example.test/a.png")));
		const { images, failures } = await fetchInboundImages(sources);
		expect(images).toHaveLength(4);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.reason).toContain("上限");
	});

	it("content-length 超限：预检拒绝，不进入 body 读取", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(PNG_BYTES, {
					status: 200,
					headers: { "content-type": "image/png", "content-length": String(20 * 1024 * 1024) },
				}),
		);
		const { images, failures } = await fetchInboundImages([
			{ mediaRef: "qq-media:10001:1", url: "https://example.test/big.png" },
		]);
		expect(images).toHaveLength(0);
		expect(failures[0]?.reason).toContain("大小上限");
	});

	it("无 content-type 时按魔数嗅探识别格式", async () => {
		vi.stubGlobal("fetch", async () => new Response(PNG_BYTES, { status: 200 }));
		const { images, failures } = await fetchInboundImages([
			{ mediaRef: "qq-media:10001:1", url: "https://example.test/a" },
		]);
		expect(failures).toHaveLength(0);
		expect(images[0]?.mimeType).toBe("image/png");
	});

	it("非 HTTP(S) 地址与失败 URL 逐条进入 failures，不阻断其余", async () => {
		vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
		const { images, failures } = await fetchInboundImages([
			{ mediaRef: "qq-media:10001:1", url: undefined, fileName: "a.png" },
			{ mediaRef: "qq-media:10001:2", url: "https://example.test/expired.png" },
		]);
		expect(images).toHaveLength(0);
		expect(failures).toHaveLength(2);
		expect(failures[0]?.reason).toContain("HTTP(S)");
		expect(failures[1]?.reason).toContain("404");
	});
});
