import { describe, expect, it } from "vitest";
import { QQ_ACTION_SCHEMAS } from "../.uina/worlds/qq/src/tool-schema.js";
import { ToolBroker } from "../src/tools/broker.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";

function qqTool() {
	const def: WorldDef = {
		name: "qq",
		description: "QQ diagnostic fixture",
		actions: Object.fromEntries(
			Object.entries(QQ_ACTION_SCHEMAS).map(([name, action]) => [
				name,
				{
					...action,
					run: () => ({ result: "ran", status: "succeeded" as const }),
				},
			]),
		),
	};
	return createWorldTool(def, { getRuntime: () => ({ definition: def, enabled: true }) });
}

function broker() {
	const value = new ToolBroker();
	value.register(qqTool());
	return value;
}

describe("selected schema branch diagnostics", () => {
	it("reports only the userRef failure instead of unrelated action alternatives", async () => {
		const tools = broker();
		const prepared = tools.prepare("qq", {
			action: "send",
			params: {
				conversationRef: "p10002",
				content: [{ type: "mention", userRef: "小明" }],
			},
		});
		const result = await tools.execute(prepared);
		expect(result.status).toBe("not_started");
		const message = JSON.parse(result.result).error;
		expect(message).toContain("/params/content/0/userRef");
		expect(message).toContain("^u[1-9]");
		expect(message).not.toContain("scope");
		expect(message).not.toContain("oneOf");
		expect(message.length).toBeLessThan(220);
		expect(result.details).toMatchObject({
			validationErrors: expect.arrayContaining([
				expect.objectContaining({ keyword: "pattern", instancePath: "/params/content/0/userRef" }),
				expect.objectContaining({ keyword: "const", instancePath: "/action" }),
			]),
		});
	});

	it("shows the required field of the selected action", async () => {
		const tools = broker();
		const result = await tools.execute(
			tools.prepare("qq", { action: "send", params: { content: [{ type: "text", text: "hi" }] } }),
		);
		expect(JSON.parse(result.result).error).toContain("conversationRef");
		expect(JSON.parse(result.result).error).not.toContain("scope");
	});

	it("selects generic enum branches and keeps every invalid array item diagnosis", async () => {
		const tools = new ToolBroker();
		let executions = 0;
		tools.register({
			def: {
				type: "function",
				function: {
					name: "generic",
					description: "generic enum branch fixture",
					parameters: {
						type: "object",
						properties: {
							entries: {
								type: "array",
								items: {
									oneOf: [
										{
											type: "object",
											properties: { operation: { enum: ["add", "replace"] }, text: { type: "string" } },
											required: ["operation", "text"],
											additionalProperties: false,
										},
										{
											type: "object",
											properties: { operation: { const: "remove" }, id: { type: "integer" } },
											required: ["operation", "id"],
											additionalProperties: false,
										},
									],
								},
							},
						},
						required: ["entries"],
						additionalProperties: false,
					},
				},
			},
			run: async () => {
				executions++;
				return { result: "ran", status: "succeeded" };
			},
		});
		const valid = await tools.execute(
			tools.prepare("generic", {
				entries: [
					{ operation: "replace", text: "hi" },
					{ operation: "remove", id: 1 },
				],
			}),
		);
		expect(valid.status).toBe("succeeded");
		const invalid = await tools.execute(
			tools.prepare("generic", {
				entries: [
					{ operation: "replace", text: 4 },
					{ operation: "remove", id: "bad" },
				],
			}),
		);
		expect(invalid.status).toBe("not_started");
		const message = JSON.parse(invalid.result).error;
		expect(message).toContain("/entries/0/text must be string");
		expect(message).toContain("/entries/1/id must be integer");
		expect(message).not.toContain("required property");
		expect(message).not.toContain("oneOf");
		const unknown = await tools.execute(tools.prepare("generic", { entries: [{ operation: "missing" }] }));
		for (const choice of ["add", "replace", "remove"]) expect(JSON.parse(unknown.result).error).toContain(choice);
		expect(executions).toBe(1);
	});

	it("retains a oneOf ambiguity failure when no branch has a field error", async () => {
		const tools = new ToolBroker();
		tools.register({
			def: {
				type: "function",
				function: {
					name: "overlap",
					description: "overlapping alternatives",
					parameters: {
						type: "object",
						oneOf: [
							{ type: "object", properties: { type: { enum: ["shared", "a"] } }, required: ["type"] },
							{ type: "object", properties: { type: { enum: ["shared", "b"] } }, required: ["type"] },
						],
					},
				},
			},
			run: async () => ({ result: "ran", status: "succeeded" }),
		});
		const result = await tools.execute(tools.prepare("overlap", { type: "shared" }));
		expect(result.status).toBe("not_started");
		expect(JSON.parse(result.result).error).toContain("must match exactly one schema in oneOf");
	});

	it.each([
		[{ params: {} }, "/action", ["send", "read", "interact"]],
		[{ action: "interact", params: { action: "bad" } }, "/params/action", ["poke", "react", "retract"]],
		[{ action: "interact", params: {} }, "/params/action", []],
		[
			{
				action: "send",
				params: {
					conversationRef: "p10002",
					content: [{ type: "sticker" }],
				},
			},
			"/params/content/0/type",
			["text", "mention", "face"],
		],
	])("offers valid selector choices without unrelated branch errors: %j", async (args, path, choices) => {
		const tools = broker();
		const result = await tools.execute(tools.prepare("qq", args));
		const message = JSON.parse(result.result).error;
		expect(message).toContain(path);
		for (const choice of choices) expect(message).toContain(choice);
		expect(message).not.toContain("oneOf");
		expect(message).not.toContain("must NOT have additional properties");
	});

	it("keeps the full error snapshot after the same validator is reused, including scoped execution", async () => {
		const tools = broker();
		const prepared = tools.prepare("qq", { action: "interact", params: { action: "bad" } });
		tools.prepare("qq", {
			action: "send",
			params: { conversationRef: "p10002", content: [{ type: "text", text: "hi" }] },
		});
		const result = await tools.createScopedView().execute(prepared);
		expect(result.details).toMatchObject({
			validationErrors: expect.arrayContaining([
				expect.objectContaining({ instancePath: "/params/action", keyword: "enum" }),
			]),
		});
	});

	it("uses the same concise formatter and full details in the WorldTool direct path", async () => {
		const result = await qqTool().run({
			action: "send",
			params: {
				conversationRef: "p10002",
				content: [{ type: "mention", userRef: "小明" }],
			},
		});
		expect(result.status).toBe("failed");
		expect(result.result).toContain("/content/0/userRef");
		expect(result.result).not.toContain("oneOf");
		expect(result.details).toMatchObject({
			action: "send",
			validationErrors: expect.arrayContaining([
				expect.objectContaining({ keyword: "pattern", instancePath: "/content/0/userRef" }),
			]),
		});
	});
});
