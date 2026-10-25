import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { ExecutorConfig } from "../contracts/executor.js";

const Ajv = createRequire(import.meta.url)("ajv") as new (
	options: object,
) => {
	compile(schema: object): ValidateFunction;
	errorsText(errors: ValidateFunction["errors"]): string;
};
const ajv = new Ajv({ allErrors: true });
const text = { type: "string", minLength: 1 };
const validate = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["connection", "binding"],
	properties: {
		connection: {
			type: "object",
			additionalProperties: false,
			required: ["host", "username", "authMode"],
			properties: {
				host: text,
				username: text,
				authMode: { const: "offline" },
				port: { type: "integer", minimum: 1, maximum: 65535 },
				version: text,
			},
		},
		binding: {
			anyOf: [
				{ type: "null" },
				{
					type: "object",
					additionalProperties: false,
					required: ["world", "worldRevision"],
					properties: { world: text, worldRevision: text },
				},
			],
		},
	},
});

export function parseExecutorConfig(raw: unknown): ExecutorConfig {
	if (!validate(raw)) {
		throw Object.assign(
			new Error(`Minecraft config: ${ajv.errorsText(validate.errors)}; this delivery supports offline only`),
			{ code: "CONFIG_INVALID" },
		);
	}
	const config = structuredClone(raw) as ExecutorConfig;
	config.connection.port ??= 25565;
	if (
		config.connection.host.trim() !== config.connection.host ||
		config.connection.username.trim() !== config.connection.username
	) {
		throw Object.assign(new Error("host/username must not contain surrounding whitespace"), { code: "CONFIG_INVALID" });
	}
	return config;
}

/** Configured endpoint identity; no DNS/alias inference or offline UUID authentication. */
export function accountKey(config: ExecutorConfig): string {
	const { host, port, username } = config.connection;
	return createHash("sha256")
		.update(JSON.stringify(["offline", host.toLowerCase().replace(/\.$/, ""), port, username.toLowerCase()]))
		.digest("hex");
}
