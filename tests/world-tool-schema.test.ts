import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { worldSucceeded } from "../src/extensions/world-framework/result.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";

const Ajv = createRequire(import.meta.url)("ajv") as new () => {
	compile: (schema: object) => (value: unknown) => boolean;
};

describe("World tool model schema", () => {
	it("exposes each action's parameter schema to the model", () => {
		const tool = createWorldTool(
			{
				name: "bilibili-live",
				description: "Bilibili live events",
				actions: {
					notification_settings: {
						description: "Read or update notification settings",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string", enum: ["status", "update"] },
								chat_messages: { type: "string", enum: ["on", "off"] },
							},
							required: ["operation"],
						},
						run: () => worldSucceeded("ok"),
					},
					status: { description: "Read status", run: () => worldSucceeded("ok") },
				},
			},
			{ getRuntime: () => ({ definition: {} as never, enabled: true }) },
		);

		const parameters = tool.def.function.parameters as Record<string, any>;
		const notificationBranch = parameters.oneOf.find(
			(branch: any) => branch.properties.action.const === "notification_settings",
		);
		const validate = new Ajv().compile(parameters);

		expect(notificationBranch.properties.params.properties.operation.enum).toEqual(["status", "update"]);
		expect(validate({ action: "notification_settings", params: { operation: "status" } })).toBe(true);
		expect(validate({ action: "notification_settings", params: { operation: "get" } })).toBe(false);
		expect(validate({ action: "notification_settings" })).toBe(false);
	});

	it("preserves an action failure instead of treating every string as success", async () => {
		const tool = createWorldTool(
			{
				name: "status-world",
				description: "Status world",
				actions: {
					fail: {
						description: "Fail",
						parameters: { type: "object", additionalProperties: false },
						run: (async () => "not executed") as any,
					},
				},
			},
			{ getRuntime: () => ({ definition: {} as never, enabled: true }) },
		);

		await expect(tool.run({ action: "fail", params: {} })).resolves.toMatchObject({ status: "failed" });
	});
});
