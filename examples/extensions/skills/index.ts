import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "../../../src/extensions/index.js";
interface Skill {
	name: string;
	path: string;
}
/** Discovery and prompt policy live together in this optional extension. */
export default async function activate(api: ExtensionAPI): Promise<void> {
	const root = resolve(api.cwd, ".uina/skills");
	async function discover(): Promise<Skill[]> {
		try {
			const entries = await readdir(root, { withFileTypes: true });
			const skills: Skill[] = [];
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				const file = entry.isDirectory()
					? join(root, entry.name, "SKILL.md")
					: entry.name.endsWith(".md")
						? join(root, entry.name)
						: undefined;
				if (!file) continue;
				try {
					await readFile(file, { encoding: "utf8", signal: api.signal });
					skills.push({ name: entry.name.replace(/\.md$/, ""), path: file });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			return skills;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
	api.registerService("skills.discover/v1", discover);
	api.onHook("turn.prepare", async () => {
		const skills = await api.callService<Skill[]>("skills.discover/v1", null, { signal: api.signal });
		if (!skills.length) return undefined;
		return {
			messages: [
				{
					role: "user",
					content:
						"[Available skills]\n" +
						skills.map((s) => s.name + ": " + s.path).join("\n") +
						"\nUse read_skill to read instructions when relevant.",
				},
			],
		};
	});
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "read_skill",
				description: "Read a discovered skill by name.",
				parameters: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
					additionalProperties: false,
				},
			},
		},
		run: async (args, signal) => {
			const skills = await api.callService<Skill[]>("skills.discover/v1", null, { signal });
			const skill = skills.find((s) => s.name === args.name);
			if (!skill) throw new Error("Skill not found: " + String(args.name));
			// The filesystem extension supplies execution; this extension supplies skill policy.
			return api.callTool("read_file", { path: skill.path }, { signal });
		},
	});
}
