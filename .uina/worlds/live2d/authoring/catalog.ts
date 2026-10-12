import type { RigControlDef } from "../adapter/rig.js";
import { compileMotion, type CompiledMotion, type MotionDefinition } from "./motion.js";

/**
 * 模型目录（P4-1，边界规范 §2）。
 *
 * 目录是工具参数的唯一合法词表来源：任何命名参数（动作/姿态/表情/注视/外观）不存在
 * 于当前目录时一律显式拒绝，不做模糊匹配。所有命名共享同一命名空间且全局唯一
 * （cue 派发按名字命中，命名冲突即语义歧义），compileCatalog 在绑定期拒绝重复。
 *
 * 快照不可变：runtime 持有 `(catalogSnapshot, generation)` 配对（边界规范 §3），
 * 目录更新产生新快照并递增代次；名字在调用受理时绑定到当时快照，执行时校验代次。
 *
 * 本模块属于 authoring 层（规范 §8：models/* → authoring + adapter），
 * 不依赖 director；AttentionTarget 是注视目标词汇，自本文件单源。
 */

/** 注视目标：具名方向（引擎内置词表）或作者标定的坐标瞄准点。 */
export type AttentionTarget =
	| { x: number; y: number }
	| "user"
	| "screen"
	| "avert_down"
	| "avert_left"
	| "avert_right";

/** 内置注视方向词表（引擎具名瞄准，非目录命名）。目录命名不得与之重复。 */
export const BUILTIN_ATTENTIONS: readonly Extract<AttentionTarget, string>[] = [
	"user",
	"screen",
	"avert_down",
	"avert_left",
	"avert_right",
];

/** 内置注视的中文朴素别名映射。 */
export const BUILTIN_ATTENTION_ALIASES: Readonly<Record<string, Extract<AttentionTarget, string>>> = {
	"看对方": "user",
	"用户": "user",
	"看用户": "user",
	"看屏幕": "screen",
	"屏幕": "screen",
	"看下方": "avert_down",
	"垂眸": "avert_down",
	"看左侧": "avert_left",
	"看右侧": "avert_right",
};

/**
 * 段级外部效果（绝对状态，进入段即生效）：与 delta（相对基准的数值偏移）正交。
 * 恢复由运行时守护统一执行——作者不书写任何重置值，末段携带 effects 在编译期拒绝。
 */
export interface SegmentEffects {
	/** 全模型染色。协议（ColorTintRequest）无过渡时间参数，进入即生效；白 (255,255,255,255) 为官方重置语义。 */
	readonly tint?: { readonly r: number; readonly g: number; readonly b: number; readonly a?: number };
	/**
	 * 场景后处理（PostProcessingUpdateRequest）。滤镜是 VTS 全局场景级效果（影响整个输出而非仅模型）；
	 * 原生支持 0-2 秒渐变（fadeTime，秒）。效果表达二选一（协议互斥，编译期校验）：
	 * - values：直接效果 config 值（如灰度 = ColorGrading_Strength 1 + ColorGrading_Saturation -100），
	 *   纯 API 值表达，零环境文件依赖，值域外协议自动 clamp；
	 * - preset：VTS Effects 环境文件名，由运行期发送前前瞻核验（VTS 可枚举预设清单）。
	 */
	readonly postProcessing?: {
		readonly on: boolean;
		readonly values?: readonly { readonly id: string; readonly value: number | string }[];
		readonly preset?: string;
		readonly fadeTime?: number;
	};
}

export interface SpatialSegment {
	/** 每一段都相对同一开始位姿，不累积前段偏移。 */
	readonly delta: {
		readonly x?: number;
		readonly y?: number;
		readonly rotation?: number;
		readonly size?: number;
	};
	/** 段级外部效果（绝对状态）。 */
	readonly effects?: SegmentEffects;
	readonly durationMs: number;
	readonly holdMs?: number;
}

export interface SpatialStuntDef {
	/** 最后一段必须回到零偏移；取消/异常另外执行归位清理。 */
	readonly segments: readonly SpatialSegment[];
}

/** 作者配置，不增加工具参数，也不依赖 director。 */
export interface CatalogPlayback {
	readonly fadeInMs?: number;
	readonly fadeOutMs?: number;
	readonly inhibitAdditives?: boolean | readonly string[];
	readonly resetVelocity?: boolean;
}

/**
 * 同义纹理变体：与主定义（池成员 0）构成随机轮换池，连播不重样（表演规范 §3：
 * 重复时允许有界的轻重/时长/方向变化，不改变关键姿势）。
 * 不入全局命名空间、不可独立寻址——agent 仍 cue 单一动作名；某变体需要被语义选择时，
 * 晋升路径是移出 variants 升为独立命名条目。
 */
export interface MotionVariant {
	/** 原始定义：express 的 speech 覆写按选中变体重编译。 */
	definition: MotionDefinition;
	/** 绑定期编译产物。 */
	motion: CompiledMotion;
}

export interface CatalogMotionEntry {
	description: string;
	/** 原始定义：express 的 speech 参数覆写时按此重编译（withSpeech 外层节点覆盖内层策略）。 */
	definition: MotionDefinition;
	/** 绑定期编译产物：非法定义在此处即失败，不进入运行时。 */
	motion: CompiledMotion;
	/** 附加变体（不含主定义）；主定义 + variants 构成轮换池，运行时均匀随机排除上次选中。 */
	variants?: readonly MotionVariant[];
	/** 可选的空间位姿特技（执行期间独占 model:transform 并保证自动归位）。 */
	spatial?: SpatialStuntDef;
	playback?: CatalogPlayback;
	/** 命名表演默认 true（边界规范 §2）；目录项可显式声明为 false。 */
	atomic: boolean;
	/** cue 别名：affordance 必须显式声明（2026-09-21 别名 cue 静默丢失缺陷的反面）。 */
	aliases?: readonly string[];
}

export interface CatalogSlotEntry {
	description: string;
	/** 轴值必须已声明于 rig.controls 且落在 [min,max]，compileCatalog 校验。 */
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

/** 环境循环条目：uina 经 ambient 工具按名选择；描述进入 status 词表，别名入全局命名空间。 */
export interface CatalogAmbientEntry {
	description: string;
	motion: CompiledMotion;
}

/** 背景循环/思考动作（引擎类别 transition；P4-4 thinking 状态驱动消费）。 */
export interface CatalogBackground {
	thinking?: CompiledMotion;
	idle?: CompiledMotion;
	/** 环境循环词表：uina 经 ambient 工具选择/清除，选中时替换 idle 成为静止态背景。 */
	ambient?: ReadonlyMap<string, CatalogAmbientEntry>;
}

export type CatalogKind = "motion" | "posture" | "expression" | "attention" | "ambient" | "costume";
export interface CatalogEntries {
 motion: CatalogMotionEntry; posture: CatalogSlotEntry; expression: CatalogSlotEntry;
 attention: CatalogAttentionEntry; ambient: CatalogAmbientEntry; costume: CatalogCostumeEntry;
}
export interface CatalogResolved<K extends CatalogKind> {
 readonly kind: K; readonly name: string; readonly aliases: readonly string[]; readonly entry: Readonly<CatalogEntries[K]>;
}
/** 索引私有，消费者只获得冻结记录；不能通过 Map.set 或原始作者对象修改快照。 */
export interface CatalogSnapshot {
 readonly modelID: string;
 readonly background: Readonly<{ idle?: CompiledMotion; thinking?: CompiledMotion }>;
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
 const add = <K extends CatalogKind>(kind: K, name: string, entry: CatalogEntries[K], aliases: readonly string[] = []) => {
  const record = freezeContent({ kind, name, aliases, entry });
  const list = records.get(kind) ?? []; const index = indexes.get(kind) ?? new Map();
  for (const word of [name, ...aliases]) {
   const owner = owners.get(word);
   if (owner) throw new Error(`命名冲突: "${word}" 已被 ${owner} 占用（目录命名空间全局唯一）`);
   owners.set(word, `${kind}.${name}`); index.set(word, record);
  }
  list.push(record); records.set(kind, list); indexes.set(kind, index);
 };
 for (const name of BUILTIN_ATTENTIONS) add("attention", name, { description: name, target: name }, Object.entries(BUILTIN_ATTENTION_ALIASES).filter(([, target]) => target === name).map(([alias]) => alias));
 const resolve = <K extends CatalogKind>(kind: K, word: string): CatalogResolved<K> | undefined => indexes.get(kind)?.get(word) as CatalogResolved<K> | undefined;
 return {
  add,
  finish(background: CatalogSnapshot["background"]): CatalogSnapshot {
   for (const list of records.values()) Object.freeze(list);
   const empty = Object.freeze([]);
   return Object.freeze({ modelID, background: freezeContent(background), resolve,
    list: <K extends CatalogKind>(kind: K) => (records.get(kind) ?? empty) as readonly CatalogResolved<K>[],
    resolveCue: (word: string) => resolve("motion", word) ?? resolve("posture", word),
   });
  }
 };
}
export const emptyCatalog = (modelID: string): CatalogSnapshot => catalogBuilder(modelID).finish({});

export interface CatalogSource {
	/** 动作输入：definition 即 motion 原始定义（编译产物由 compileCatalog 生成，不进输入）。 */
	motions?: Readonly<
		Record<
			string,
			{
				description: string;
				motion: MotionDefinition;
				/** 附加变体原始定义（不含主定义）；绑定期逐个编译，非法即抛。 */
				variants?: readonly MotionDefinition[];
				spatial?: SpatialStuntDef;
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
		thinking?: MotionDefinition;
		idle?: MotionDefinition;
		ambient?: Record<string, { description: string; aliases?: readonly string[]; motion: MotionDefinition }>;
	};
}

const take = <T>(record: Readonly<Record<string, T>> | undefined): Map<string, T> =>
	new Map(Object.entries(record ?? {}));

/**
 * 绑定期编译与校验：动作编译（非法定义即抛）、轴值范围核验、全命名空间唯一性
 * （含内置注视词表与别名占用）。任何失败都阻止模型包装配，不带病上线。
 */
export function compileCatalog(
	modelID: string,
	source: CatalogSource,
	rig: { controls: Readonly<Record<string, RigControlDef>>; modelID: string },
): CatalogSnapshot {
	source = structuredClone(source);
	if (rig.modelID !== modelID) throw new Error(`目录模型身份不符: 目录 ${modelID} vs rig ${rig.modelID}`);
	const motions = new Map<string, CatalogMotionEntry>();
	for (const [name, entry] of Object.entries(source.motions ?? {})) {
		if (entry.spatial) {
			const segments = entry.spatial.segments;
			if (!segments?.length) throw new Error(`动作 "${name}" 空间轨迹为空`);
			let hasPayload = false;
			const validateEffects = (effects: SegmentEffects, index: number): void => {
				const label = `动作 "${name}" 空间段[${index}]`;
				if (effects.tint !== undefined) {
					const { r, g, b, a } = effects.tint;
					for (const [channel, value] of [
						["r", r],
						["g", g],
						["b", b],
						["a", a ?? 255],
					] as const)
						if (!Number.isInteger(value) || value < 0 || value > 255)
							throw new Error(`${label} 染色通道 ${channel} 必须是 0-255 整数: ${value}`);
				}
				if (effects.postProcessing !== undefined) {
					if (typeof effects.postProcessing.on !== "boolean")
						throw new Error(`${label} 后处理 on 必须是布尔值`);
					const { fadeTime, values, preset } = effects.postProcessing;
					if (fadeTime !== undefined && (!Number.isFinite(fadeTime) || fadeTime < 0 || fadeTime > 2))
						throw new Error(`${label} 后处理渐变时间必须是 0-2 秒: ${fadeTime}`);
					// 效果表达二选一：values（直接 config 值）与 preset（环境文件名）协议互斥。
					if (values !== undefined && preset !== undefined)
						throw new Error(`${label} 后处理 values 与 preset 互斥，只能二选一`);
					if (values !== undefined) {
						if (!Array.isArray(values) || values.length === 0)
							throw new Error(`${label} 后处理 values 必须是非空数组`);
						for (const item of values) {
							if (typeof item?.id !== "string" || item.id.length === 0)
								throw new Error(`${label} 后处理 values 项缺少 configID: ${JSON.stringify(item)}`);
							if (!["number", "string"].includes(typeof item.value))
								throw new Error(`${label} 后处理 config "${item.id}" 的值必须是 number 或 string: ${JSON.stringify(item)}`);
						}
					}
				}
			};
			for (const [index, segment] of segments.entries()) {
				if (!Number.isFinite(segment.durationMs) || segment.durationMs <= 0 || segment.durationMs > 2000)
					throw new Error(`动作 "${name}" 空间段 durationMs 必须在 (0,2000]`);
				if (segment.holdMs !== undefined && (!Number.isFinite(segment.holdMs) || segment.holdMs < 0))
					throw new Error(`动作 "${name}" 空间段 holdMs 必须为非负有限数`);
				if (segment.delta) {
					// delta 数值域 lint（弱校验）：超出 VTS 字段值域的偏移按作者笔误提前拒绝；
					// 真约束在运行时——实发绝对值 = base + delta，base 只有运行时可知（VTS_MOVE_LIMITS）。
					const deltaLimits: Record<string, number> = { x: 1000, y: 1000, rotation: 360, size: 100 };
					for (const [axis, offset] of Object.entries(segment.delta)) {
						if (!["x", "y", "rotation", "size"].includes(axis) || !Number.isFinite(offset))
							throw new Error(`动作 "${name}" 空间偏移非法: ${axis}`);
						if (offset !== 0) hasPayload = true;
						if (Math.abs(offset) > deltaLimits[axis]!)
							throw new Error(`动作 "${name}" 空间偏移超出 VTS 值域: ${axis}=${offset}（±${deltaLimits[axis]}）`);
					}
				}
				const hasEffects = segment.effects !== undefined && Object.keys(segment.effects).length > 0;
				if (!hasEffects && (!segment.delta || Object.keys(segment.delta).length === 0))
					throw new Error(`动作 "${name}" 空间段必须声明 delta 或 effects`);
				if (hasEffects) {
					hasPayload = true;
					validateEffects(segment.effects!, index);
				}
			}
			if (!hasPayload) throw new Error(`动作 "${name}" 空间轨迹无载荷`);
			const last = segments.at(-1)!;
			if (Object.values(last.delta).some((offset) => offset !== 0))
				throw new Error(`动作 "${name}" 空间轨迹末段必须归零`);
			if (last.effects !== undefined && Object.keys(last.effects).length > 0)
				throw new Error(`动作 "${name}" 空间轨迹末段不得携带 effects——恢复由运行时守护统一执行`);
		}
		for (const value of [entry.playback?.fadeInMs, entry.playback?.fadeOutMs]) {
			if (value !== undefined && (!Number.isFinite(value) || value < 0))
				throw new Error(`动作 "${name}" 播放淡入/淡出必须为非负有限数`);
		}
		if (Array.isArray(entry.playback?.inhibitAdditives)) {
			for (const axis of entry.playback.inhibitAdditives)
				if (!rig.controls[axis]) throw new Error(`动作 "${name}" 抑制未声明轴: ${axis}`);
		}
		// 变体池：附加变体逐个编译（非法定义即抛）；池总数 ≥ 2 才构成轮换，空池拒绝。
		const variants = entry.variants?.map((definition) => ({ definition, motion: compileMotion(definition, rig.controls) }));
		if (entry.variants !== undefined && (variants?.length ?? 0) < 1)
			throw new Error(`动作 "${name}" 变体池为空：主定义 + 变体必须 ≥ 2 才构成轮换`);
		motions.set(name, {
			description: entry.description,
			definition: entry.motion,
			motion: compileMotion(entry.motion, rig.controls),
			variants,
			spatial: entry.spatial,
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
	// 环境循环：绑定期编译（非法定义即抛），命名与别名同受全局唯一命名空间约束。
	const ambientSource = new Map<string, { description: string; aliases?: readonly string[]; motion: CompiledMotion }>();
	for (const [name, entry] of Object.entries(source.background?.ambient ?? {}))
		ambientSource.set(name, { description: entry.description, aliases: entry.aliases, motion: compileMotion(entry.motion, rig.controls) });
	const attentions = take(source.attentions);
	for (const name of attentions.keys()) {
		if ((BUILTIN_ATTENTIONS as readonly string[]).includes(name))
			throw new Error(`注视命名 "${name}" 与引擎内置词表冲突`);
	}
 const builder = catalogBuilder(modelID);
 for (const [name, entry] of motions) builder.add("motion", name, entry, entry.aliases);
 for (const [name, entry] of postures) builder.add("posture", name, entry, entry.aliases);
 for (const [name, entry] of expressions) builder.add("expression", name, entry, entry.aliases);
 for (const [name, entry] of attentions) builder.add("attention", name, entry);
 for (const [name, entry] of ambientSource) builder.add("ambient", name, entry, entry.aliases);
 for (const entry of source.costumes ?? []) builder.add("costume", entry.id, entry);
 return builder.finish({
  thinking: source.background?.thinking ? compileMotion(source.background.thinking, rig.controls) : undefined,
  idle: source.background?.idle ? compileMotion(source.background.idle, rig.controls) : undefined,
 });
}
