import { describe, expect, it } from "vitest";
import { toWireMessages } from "../src/ai/gateway.js";
import { anthropicMessages, geminiRequest } from "../src/ai/providers.js";
import type { ImageContent } from "../src/core/content.js";
import type { ChatMsg } from "../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

const images: ImageContent[] = [
	{ type: "image", mimeType: "image/png", data: "YQ==", alt: "Attachment a1 from message m1" },
	{ type: "image", mimeType: "image/jpeg", data: "Yg==" },
	{ type: "image", mimeType: "image/webp", data: "Yw==", alt: "Attachment a3 from message m2" },
];
const openaiParts = [
	{ type: "text", text: "Attachment a1 from message m1" },
	{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
	{ type: "image_url", image_url: { url: "data:image/jpeg;base64,Yg==" } },
	{ type: "text", text: "Attachment a3 from message m2" },
	{ type: "image_url", image_url: { url: "data:image/webp;base64,Yw==" } },
];
const anthropicParts = [
	{ type: "text", text: "Attachment a1 from message m1" },
	{ type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
	{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Yg==" } },
	{ type: "text", text: "Attachment a3 from message m2" },
	{ type: "image", source: { type: "base64", media_type: "image/webp", data: "Yw==" } },
];
const geminiParts = [
	{ text: "Attachment a1 from message m1" },
	{ inlineData: { mimeType: "image/png", data: "YQ==" } },
	{ inlineData: { mimeType: "image/jpeg", data: "Yg==" } },
	{ text: "Attachment a3 from message m2" },
	{ inlineData: { mimeType: "image/webp", data: "Yw==" } },
];

function messages(): ChatMsg[] {
	return [
		{ role: "user", content: "look", images },
		{
			role: "assistant",
			content: "",
			tool_calls: [
				{ id: "a", name: "read", args: {} },
				{ id: "b", name: "read", args: {} },
			],
		},
		{ role: "tool", content: "first", tool_call_id: "a", status: "succeeded", images },
		{ role: "tool", content: "second", tool_call_id: "b", status: "succeeded", images: [images[1]!] },
		{ role: "user", content: "next", images: [images[2]!] },
	];
}

describe("image labels on final provider wire", () => {
	it("puts OpenAI labels immediately before their images and keeps tool groups ordered", () => {
		const wire = toWireMessages(messages()) as Array<{ role: string; content: unknown }>;
		expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user", "user"]);
		expect(wire[0]!.content).toEqual([{ type: "text", text: "look" }, ...openaiParts]);
		expect(wire[4]!.content).toEqual([
			{ type: "text", text: "Images from tool call a" },
			...openaiParts,
			{ type: "text", text: "Images from tool call b" },
			openaiParts[2],
		]);
		expect(wire[5]!.content).toEqual([{ type: "text", text: "next" }, ...openaiParts.slice(3)]);
	});

	it("puts Anthropic labels inside the correct tool_result while retaining merged user order", () => {
		const wire = anthropicMessages({ messages: messages(), providerHooks: NO_RUNTIME_HOOKS.provider }) as Array<{
			content: unknown;
		}>;
		expect(wire[0]!.content).toEqual([{ type: "text", text: "look" }, ...anthropicParts]);
		expect(wire[2]!.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "a",
				is_error: false,
				content: [{ type: "text", text: "first" }, ...anthropicParts],
			},
			{
				type: "tool_result",
				tool_use_id: "b",
				is_error: false,
				content: [{ type: "text", text: "second" }, anthropicParts[2]],
			},
			{ type: "text", text: "next" },
			...anthropicParts.slice(3),
		]);
	});

	it("keeps Gemini labels next to each image after the correct function response", () => {
		const wire = geminiRequest({ messages: messages(), providerHooks: NO_RUNTIME_HOOKS.provider }, true) as {
			contents: Array<{ parts: unknown[] }>;
		};
		expect(wire.contents[0]!.parts).toEqual([{ text: "look" }, ...geminiParts]);
		expect(wire.contents[2]!.parts).toEqual([
			{ functionResponse: { id: "a", name: "read", response: { output: "first" } } },
			...geminiParts,
			{ functionResponse: { id: "b", name: "read", response: { output: "second" } } },
			geminiParts[2],
		]);
		expect(wire.contents[3]!.parts).toEqual([{ text: "next" }, ...geminiParts.slice(3)]);
	});
});
