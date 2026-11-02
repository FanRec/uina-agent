/**
 * remember@1：把命名地点写进 World 领域记录（同名覆盖）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §5 记录。
 * `at` 省略 = 当前位置；显式维度照存（§2.2：跨维度地点不简化成三个数）。
 * 写路径 = readRecord → 有则 CAS 覆盖（expectedRevision=revision）/ 无则创建；
 * CONFLICT（并发写者抢先）重试一次后如实上抛。evidence=[]：记录本身是本次动作，
 * 不引用会过期的观察证据。分区取 self 的世界身份，World 侧校验与当前绑定一致。
 */

import type { SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { DomainRecord } from "../../contracts/world.js";
import { PLACE_SCHEMA, type PlaceKind, type PlaceValue, placeRef } from "../../world/places.js";
import type { CapabilityDeps } from "../deps.js";
import { readValue } from "../shared/observe.js";
import { POS_SCHEMA } from "../shared/schema.js";
import { fail, resolvePoint } from "../shared/targets.js";

const descriptor: CallableDescriptor = {
	ref: "remember@1",
	summary: "Save a named place (with dimension) into Uina's per-world record; same name overwrites; survives restarts",
	tags: ["records"],
	input: {
		type: "object",
		properties: {
			name: { type: "string", minLength: 1, maxLength: 32, description: "place name (no control characters)" },
			at: POS_SCHEMA,
			kind: { type: "string", enum: ["home", "mine", "farm", "other"], description: "default other" },
			note: { type: "string", maxLength: 200 },
		},
		required: ["name"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			name: { type: "string" },
			at: { type: "object" },
			kind: { type: "string" },
		},
		required: ["name", "at", "kind"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description: "the record revision is committed in the world record store (CAS settled)",
	},
	errors: [
		{ code: "INVALID_INPUT", meaning: "name is empty, whitespace-only, over 32 chars or has control characters" },
		{ code: "CONFLICT", meaning: "another writer moved the record revision; retry converged or failed honestly" },
		{ code: "WRONG_STATE", meaning: "current self facts are unavailable" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { name: "base", kind: "home", note: "main storage" },
			output: {
				name: "base",
				at: { position: { x: 128.5, y: 64, z: -256 }, dimension: "minecraft:overworld" },
				kind: "home",
			},
		},
	],
	implementation: "native",
};

export function normalizePlaceName(name: string): string {
	const value = name.trim();
	if (value.length === 0 || value.length > 32 || /[\u0000-\u001f\u007f]/.test(value)) {
		fail("INVALID_INPUT", `place name must be 1..32 visible characters: ${JSON.stringify(name)}`, {
			hint: "use a short name like base or mine-north",
		});
	}
	return value;
}

/** CAS 写入：读旧修订 → 覆盖/创建；CONFLICT 重读重试（有界），仍冲突则如实上抛。 */
export async function upsertPlaceRecord(
	ctx: CallContext,
	partition: { world: string; worldRevision: string },
	name: string,
	value: PlaceValue,
): Promise<DomainRecord> {
	const ref = placeRef(name);
	// 有界重试：并发写者恰好抢先时重读修订再试；连撞 3 次说明存在持续竞争，如实上报。
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const existing = await ctx.world.readRecord(ref).catch((err: { code?: string }) => {
			if (err.code === "NOT_FOUND") return null;
			throw err;
		});
		try {
			return await ctx.world.writeRecord({
				ref,
				schema: PLACE_SCHEMA,
				world: partition.world,
				worldRevision: partition.worldRevision,
				expectedRevision: existing == null ? null : existing.revision,
				// PlaceValue 全量 JSON 安全；这里过 plain 是合同边界的单点纯化。
				value: plain(value),
				evidence: [],
			});
		} catch (err) {
			if ((err as { code?: string }).code !== "CONFLICT") throw err;
		}
	}
	fail("CONFLICT", `place record ${ref} kept moving under concurrent writers; retry the call`, {
		hint: "another writer keeps updating the same name; a fresh remember picks up the latest revision",
	});
}

export function rememberCallable(_deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void _deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as {
				name: string;
				at?: unknown;
				kind?: PlaceKind;
				note?: string;
			};
			const name = normalizePlaceName(raw.name);
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const target = resolvePoint(raw.at ?? self.place.position, self);
			const value: PlaceValue = {
				name,
				at: { position: target.position, dimension: target.dimension },
				kind: raw.kind ?? "other",
				savedAt: new Date().toISOString(),
			};
			if (raw.note != null) value.note = raw.note;
			await upsertPlaceRecord(ctx, { world: self.place.world, worldRevision: self.place.worldRevision }, name, value);
			return plain({ name, at: { position: target.position, dimension: target.dimension }, kind: value.kind });
		},
	};
}
