/** One request schema reused by the World tool and fixed IPC method. */
const text = { type: "string" };
const name = { type: "string" };
const kind = { enum: ["program", "blueprint", "experience"] };
const strings = { type: "array", items: text };
const object = (properties: object, required: string[] = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const schema = { type: "object" };
const examples = { type: "array", items: object({ input: {}, output: {} }, ["input"]) };
const programMetadata = { summary: text, tags: strings, input: schema, output: schema, examples };
const programKind = { const: "program" };
const common = { name, kind: programKind };
const save = { op: { const: "save" }, ...common, ...programMetadata };
const update = { op: { const: "update" }, ...common, expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" } };
const patch = object(
	{
		summary: text,
		tags: nullable(strings),
		input: nullable(schema),
		output: nullable(schema),
		examples: nullable(examples),
	},
	[],
);
export const librarySchema = {
	oneOf: [
		object({ op: { const: "list" }, kind, text, tag: text, limit: { type: "integer", minimum: 1 } }, ["op"]),
		object({ op: { enum: ["get", "delete"] }, kind, name }, ["op", "name"]),
		object({ ...save, source: text }, ["op", "name", "summary", "source"]),
		object({ ...save, from: object({ run: text, segment: text, call: text }) }, ["op", "name", "summary", "from"]),
		object({ ...update, source: text }, ["op", "name", "source"]),
		object({ ...update, metadata: patch }, ["op", "name", "metadata"]),
		object({ op: { const: "save" }, kind: { const: "experience" }, name, text }),
		object(
			{ op: { const: "update" }, kind: { const: "experience" }, name, expectedDigest: update.expectedDigest, text },
			["op", "kind", "name", "text"],
		),
		object(
			{
				op: { const: "update" },
				kind: { const: "experience" },
				name,
				expectedDigest: update.expectedDigest,
				metadata: object({ summary: nullable(text), tags: nullable(strings), applies: nullable(strings) }, []),
			},
			["op", "kind", "name", "metadata"],
		),
		object({ op: { const: "save" }, kind: { const: "blueprint" }, name, summary: text, tags: strings }, [
			"op",
			"kind",
			"name",
			"summary",
		]),
		object({
			op: { const: "update" },
			kind: { const: "blueprint" },
			name,
			metadata: object({ summary: text, tags: nullable(strings) }, []),
		}),
	],
};

const entryBase = {
	name: text,
	summary: nullable(text),
	tags: strings,
	path: text,
	updatedAt: text,
	headerError: text,
	aboutError: text,
};
const requiredEntry = ["kind", "name", "summary", "tags", "path", "updatedAt"];
const entry = (properties: object, required: string[]) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const programEntry = entry(
	{
		...entryBase,
		kind: programKind,
		digest: text,
		source: text,
		input: schema,
		output: schema,
		examples,
		savedFrom: object({ run: text, segment: text, call: text, digest: text, at: text }),
	},
	[...requiredEntry, "digest"],
);
const fileBase = { ...entryBase, size: { type: "integer", minimum: 0 }, digest: text };
const blueprintEntry = entry(
	{
		...fileBase,
		kind: { const: "blueprint" },
		about: nullable(schema),
		files: strings,
		formatHint: text,
		target: object({ schema: text, digest: text, validation: { const: "unavailable" } }),
	},
	requiredEntry,
);
const experienceEntry = entry(
	{ ...fileBase, kind: { const: "experience" }, header: nullable(schema), text },
	requiredEntry,
);
const libraryEntry = { oneOf: [programEntry, blueprintEntry, experienceEntry] };
export const libraryResultSchema = { oneOf: [libraryEntry, { type: "array", items: libraryEntry }, { type: "null" }] };
