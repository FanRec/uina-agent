import type { RigControlDef } from "../adapter/rig.js";
import { compileAction, type ActionAuthoring } from "./action.js";

/** Named catalog is the sole source of model-specific affordances. */
export type AttentionTarget =
	| { x: number; y: number }
	| "user"
	| "screen"
	| "avert_down"
	| "avert_left"
	| "avert_right";

export const BUILTIN_ATTENTIONS: readonly Extract<AttentionTarget, string>[] = Object.freeze([
	"user",
	"screen",
	"avert_down",
	"avert_left",
	"avert_right",
]);

export const BUILTIN_ATTENTION_ALIASES: Readonly<Record<string, Extract<AttentionTarget, string>>> = Object.freeze({
	看对方: "user",
	用户: "user",
	看用户: "user",
	看屏幕: "screen",
	屏幕: "screen",
	看下方: "avert_down",
	垂眸: "avert_down",
	看左侧: "avert_left",
	看右侧: "avert_right",
});

export interface CatalogPlayback {
	readonly fadeInMs?: number;
	readonly fadeOutMs?: number;
	readonly inhibitAdditives?: boolean | readonly string[];
	readonly resetVelocity?: boolean;
}

export interface CatalogMotionEntry {
	description: string;
	definition: ActionAuthoring;
	variants?: readonly ActionAuthoring[];
	playback?: CatalogPlayback;
	atomic: boolean;
	aliases?: readonly string[];
}

export interface CatalogSlotEntry {
	description: string;
	values: Readonly<Record<string, number>>;
	transitionMs?: number;
	aliases?: readonly string[];
}

export interface CatalogAttentionEntry {
	description: string;
	target: AttentionTarget;
}

export interface CatalogCostumeEntry {
	id: string;
	description: string;
	hotkeyID: string;
}

export interface CatalogAmbientEntry {
	description: string;
	motion: ActionAuthoring;
	variants?: readonly ActionAuthoring[];
	aliases?: readonly string[];
}

export interface CatalogBackground {
	thinking?: ActionAuthoring;
	idle?: ActionAuthoring;
	ambient?: ReadonlyMap<string, CatalogAmbientEntry>;
}

export type CatalogKind = "motion" | "posture" | "expression" | "attention" | "ambient" | "costume";
export interface CatalogEntries {
	motion: CatalogMotionEntry;
	posture: CatalogSlotEntry;
	expression: CatalogSlotEntry;
	attention: CatalogAttentionEntry;
	ambient: CatalogAmbientEntry;
	costume: CatalogCostumeEntry;
}

export interface CatalogResolved<K extends CatalogKind> {
	readonly kind: K;
	readonly name: string;
	readonly aliases: readonly string[];
	readonly entry: Readonly<CatalogEntries[K]>;
}

export interface CatalogSnapshot {
	readonly modelID: string;
	readonly background: Readonly<{ idle?: ActionAuthoring; thinking?: ActionAuthoring }>;
	resolve<K extends CatalogKind>(kind: K, nameOrAlias: string): CatalogResolved<K> | undefined;
	list<K extends CatalogKind>(kind: K): readonly CatalogResolved<K>[];
	resolveCue(nameOrAlias: string): CatalogResolved<"motion"> | CatalogResolved<"posture"> | undefined;
}

function freezeContent<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === "object" && !seen.has(value)) {
		seen.add(value);
		for (const child of Object.values(value)) freezeContent(child, seen);
		Object.freeze(value);
	}
	return value;
}

function catalogBuilder(modelID: string) {
	const owners = new Map<string, string>();
	const records = new Map<CatalogKind, CatalogResolved<CatalogKind>[]>();
	const indexes = new Map<CatalogKind, Map<string, CatalogResolved<CatalogKind>>>();
	const add = <K extends CatalogKind>(
		kind: K,
		name: string,
		entry: CatalogEntries[K],
		aliases: readonly string[] = [],
	) => {
		const record = freezeContent({ kind, name, aliases, entry });
		const list = records.get(kind) ?? [];
		const index = indexes.get(kind) ?? new Map();
		for (const word of [name, ...aliases]) {
			if (typeof word !== "string" || word.length === 0) throw new Error(`${kind} 名称与别名必须是非空字符串`);
			const owner = owners.get(word);
			if (owner) throw new Error(`命名冲突: "${word}" 已被 ${owner} 占用（目录命名空间全局唯一）`);
			owners.set(word, `${kind}.${name}`);
			index.set(word, record);
		}
		list.push(record);
		records.set(kind, list);
		indexes.set(kind, index);
	};
	for (const name of BUILTIN_ATTENTIONS)
		add(
			"attention",
			name,
			{ description: name, target: name },
			Object.entries(BUILTIN_ATTENTION_ALIASES)
				.filter(([, target]) => target === name)
				.map(([alias]) => alias),
		);
	const resolve = <K extends CatalogKind>(kind: K, word: string): CatalogResolved<K> | undefined =>
		indexes.get(kind)?.get(word) as CatalogResolved<K> | undefined;
	return {
		add,
		finish(background: CatalogSnapshot["background"]): CatalogSnapshot {
			for (const list of records.values()) Object.freeze(list);
			const empty = Object.freeze([]);
			return Object.freeze({
				modelID,
				background: freezeContent(background),
				resolve,
				list: <K extends CatalogKind>(kind: K) => (records.get(kind) ?? empty) as readonly CatalogResolved<K>[],
				resolveCue: (word: string) => resolve("motion", word) ?? resolve("posture", word),
			});
		},
	};
}

export const emptyCatalog = (modelID: string): CatalogSnapshot => catalogBuilder(modelID).finish({});

export interface CatalogSource {
	motions?: Readonly<
		Record<
			string,
			{
				description: string;
				motion: ActionAuthoring;
				variants?: readonly ActionAuthoring[];
				playback?: CatalogPlayback;
				atomic?: boolean;
				aliases?: readonly string[];
			}
		>
	>;
	postures?: Readonly<Record<string, CatalogSlotEntry>>;
	expressions?: Readonly<Record<string, CatalogSlotEntry>>;
	attentions?: Readonly<Record<string, CatalogAttentionEntry>>;
	costumes?: readonly CatalogCostumeEntry[];
	background?: {
		thinking?: ActionAuthoring;
		idle?: ActionAuthoring;
		ambient?: Record<
			string,
			{
				description: string;
				aliases?: readonly string[];
				motion: ActionAuthoring;
				variants?: readonly ActionAuthoring[];
			}
		>;
	};
}

const take = <T>(record: Readonly<Record<string, T>> | undefined): Map<string, T> =>
	new Map(Object.entries(record ?? {}));
const STUB_RNG = (): number => 0;

function cloneAuthoring<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Map || value instanceof Set || value instanceof Date)
		throw new Error("CatalogSource 含不支持的结构（Map/Set/Date）：请使用普通对象与数组");
	if (seen.has(value)) return seen.get(value) as T;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(cloneAuthoring(item, seen));
		return copy as unknown as T;
	}
	const copy: Record<string, unknown> = {};
	seen.set(value, copy);
	for (const [key, child] of Object.entries(value)) copy[key] = cloneAuthoring(child, seen);
	return copy as T;
}

/** Validate ActionAuthoring with a fixed probe stream, discard the result, and store only the factory. */
export function compileCatalog(
	modelID: string,
	source: CatalogSource,
	rig: { controls: Readonly<Record<string, RigControlDef>>; modelID: string },
): CatalogSnapshot {
	source = cloneAuthoring(source);
	if (rig.modelID !== modelID) throw new Error(`目录模型身份不符: 目录 ${modelID} vs rig ${rig.modelID}`);
	const motions = new Map<string, CatalogMotionEntry>();
	for (const [name, entry] of Object.entries(source.motions ?? {})) {
		for (const value of [entry.playback?.fadeInMs, entry.playback?.fadeOutMs])
			if (value !== undefined && (!Number.isFinite(value) || value < 0))
				throw new Error(`动作 "${name}" 播放淡入/淡出必须为非负有限数`);
		if (Array.isArray(entry.playback?.inhibitAdditives))
			for (const axis of entry.playback.inhibitAdditives)
				if (!rig.controls[axis]) throw new Error(`动作 "${name}" 抑制未声明轴: ${axis}`);
		if (entry.variants !== undefined) {
			if (entry.variants.length < 1) throw new Error(`动作 "${name}" 变体池为空：主定义 + 变体必须至少有两个成员`);
			for (const variant of entry.variants) compileAction(variant, rig.controls, STUB_RNG);
		}
		compileAction(entry.motion, rig.controls, STUB_RNG);
		motions.set(name, {
			description: entry.description,
			definition: entry.motion,
			variants: entry.variants,
			playback: entry.playback,
			atomic: entry.atomic ?? true,
			aliases: entry.aliases,
		});
	}
	const validateSlot = (name: string, slot: CatalogSlotEntry, kind: string): void => {
		if (slot.transitionMs !== undefined && (!Number.isFinite(slot.transitionMs) || slot.transitionMs < 0))
			throw new Error(`${kind} "${name}" transitionMs 必须为非负有限数`);
		for (const [axis, value] of Object.entries(slot.values)) {
			const control = rig.controls[axis];
			if (!control) throw new Error(`${kind} "${name}" 引用未声明控制: ${axis}`);
			if (!Number.isFinite(value) || value < control.min || value > control.max)
				throw new Error(`${kind} "${name}" 轴值越界: ${axis}=${value} ∉ [${control.min},${control.max}]`);
		}
	};
	const postures = take(source.postures);
	for (const [name, slot] of postures) validateSlot(name, slot, "姿态");
	const expressions = take(source.expressions);
	for (const [name, slot] of expressions) validateSlot(name, slot, "表情");
	const ambientSource = new Map<string, CatalogAmbientEntry>();
	for (const [name, entry] of Object.entries(source.background?.ambient ?? {})) {
		compileAction(entry.motion, rig.controls, STUB_RNG);
		for (const variant of entry.variants ?? []) compileAction(variant, rig.controls, STUB_RNG);
		ambientSource.set(name, {
			description: entry.description,
			aliases: entry.aliases,
			motion: entry.motion,
			variants: entry.variants,
		});
	}
	if (source.background?.idle) compileAction(source.background.idle, rig.controls, STUB_RNG);
	if (source.background?.thinking) compileAction(source.background.thinking, rig.controls, STUB_RNG);
	const attentions = take(source.attentions);
	for (const name of attentions.keys())
		if ((BUILTIN_ATTENTIONS as readonly string[]).includes(name))
			throw new Error(`注视命名 "${name}" 与引擎内置词表冲突`);
	const builder = catalogBuilder(modelID);
	for (const [name, entry] of motions) builder.add("motion", name, entry, entry.aliases);
	for (const [name, entry] of postures) builder.add("posture", name, entry, entry.aliases);
	for (const [name, entry] of expressions) builder.add("expression", name, entry, entry.aliases);
	for (const [name, entry] of attentions) builder.add("attention", name, entry);
	for (const [name, entry] of ambientSource) builder.add("ambient", name, entry, entry.aliases);
	for (const entry of source.costumes ?? []) builder.add("costume", entry.id, entry);
	return builder.finish({ thinking: source.background?.thinking, idle: source.background?.idle });
}
