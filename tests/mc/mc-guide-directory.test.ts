/** 官方只读 Guide：通过现有 describe 发现与读取，不新增工具、不污染 Library。 */
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const Ajv = createRequire(import.meta.url)("ajv") as new (options: {
	strict: boolean;
}) => {
	compile(schema: object): (value: unknown) => boolean;
};
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { describeDirectory } from "../../.uina/worlds/minecraft/companion/directory.js";
import { GUIDES, readGuide } from "../../.uina/worlds/minecraft/companion/guides/index.js";
import { createLibrary } from "../../.uina/worlds/minecraft/library/index.js";
import { actionSchemas, nativeGuide } from "../../.uina/worlds/minecraft/worlddef/schema.js";

async function library() {
	const root = await mkdtemp(join(tmpdir(), "uina-guides-"));
	return createLibrary({
		dataRoot: root,
		compile: async (p) => ({ ok: true, digest: p.digest }),
		readSource: async () => null,
	});
}

test("describe {kind:'guide'} 返回官方正文且永不 callable；未知名字明确失败", async () => {
	const lib = await library();
	const entry = (await describeDirectory(createCapabilityCatalog().allDescriptors(), lib, {
		kind: "guide",
		name: "program_api",
	})) as {
		kind: string;
		callable: boolean;
		name: string;
		content: string;
		tags: string[];
	};
	expect(entry).toMatchObject({ kind: "guide", callable: false, name: "program_api" });
	expect(entry.content).toContain("mc.call");
	expect(entry.content).toContain("mc.read");
	expect(entry.tags).toContain("api");
	// 正文确实来自打包资源，而不是摘要拼凑。
	expect(entry.content).toBe(await readGuide("program_api"));
	await expect(
		describeDirectory(createCapabilityCatalog().allDescriptors(), lib, { kind: "guide", name: "no_such_guide" }),
	).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
});

test("Guide 参与检索与家族计数，但不进 reads/acts，不写 Library", async () => {
	const lib = await library();
	const overview = (await describeDirectory(createCapabilityCatalog().allDescriptors(), lib, {})) as {
		families: { kind: string; count: number }[];
		reads: string[];
		acts: string[];
	};
	expect(overview.families).toContainEqual({ kind: "guide", count: GUIDES.length });
	expect(overview.reads).not.toContain("program_api");
	expect(overview.acts).not.toContain("program_api");

	const mining = (await describeDirectory(createCapabilityCatalog().allDescriptors(), lib, { query: "mining" })) as {
		items: { kind: string; name: string; nextCall: { action: string } }[];
	};
	expect(mining.items.some((item) => item.kind === "guide" && item.name === "mining_playbook")).toBe(true);
	expect(
		mining.items.filter((item) => item.kind === "guide").every((item) => item.nextCall.action === "describe"),
	).toBe(true);

	// exact > prefix > summary/tags：精确名字必须排第一。
	const exact = (await describeDirectory(createCapabilityCatalog().allDescriptors(), lib, {
		query: "program_api",
	})) as {
		items: { name: string }[];
	};
	expect(exact.items[0]?.name).toBe("program_api");

	// 裸名缺省 kind 仍按旧的 program 规则解析，旧程序选择语义不变。
	await lib.save({ name: "echo", summary: "reuse", source: "async function main(){return 1;}" });
	expect(await describeDirectory(createCapabilityCatalog().allDescriptors(), lib, { name: "echo" })).toMatchObject({
		kind: "program",
	});
	expect((await lib.list({ limit: 100 })).some((e) => e.name === "echo")).toBe(true);
	expect((await lib.list({ limit: 100 })).some((e) => (e.kind as string) === "guide")).toBe(false);
});

test("describe 的公开 schema 接受 guide，且工具 description 不再塞 API 长文", async () => {
	const validate = new Ajv({ strict: false }).compile(actionSchemas.describe!);
	expect(validate({ kind: "guide", name: "body_api" })).toBe(true);
	expect(validate({ query: "mining" })).toBe(true);
	expect(validate({ kind: "unknown_kind", name: "x" })).toBe(false);
	// 常驻 description 只剩入口；API 细节全部移到按需 Guide。
	expect(nativeGuide.length).toBeLessThan(900);
	expect(nativeGuide).not.toContain("mc.withBody(async");
	expect(nativeGuide).not.toContain("shortWindow");
	expect(nativeGuide).not.toContain("placeToReach:true");
	expect(nativeGuide).toContain("kind:'guide'");
});
