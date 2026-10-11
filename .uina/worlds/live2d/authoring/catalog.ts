import type { RigControlDef } from "../adapter/rig.js";
import { compileMotion, withSpeech, type CompiledMotion, type MotionDefinition, type SpeechPolicy } from "./motion.js";

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
export type AttentionTarget = { x: number; y: number } | "user" | "screen" | "avert_down" | "avert_left" | "avert_right";

/** 内置注视方向词表（引擎具名瞄准，非目录命名）。目录命名不得与之重复。 */
export const BUILTIN_ATTENTIONS: readonly Extract<AttentionTarget, string>[] = [
	"user",
	"screen",
	"avert_down",
	"avert_left",
	"avert_right",
];

export interface CatalogMotionEntry {
	description: string;
	/** 原始定义：express 的 speech 参数覆写时按此重编译（withSpeech 外层节点覆盖内层策略）。 */
	definition: MotionDefinition;
	/** 绑定期编译产物：非法定义在此处即失败，不进入运行时。 */
	motion: CompiledMotion;
	/** 命名表演默认 true（边界规范 §2）；目录项可显式声明为 false。 */
	atomic: boolean;
	/** cue 别名：affordance 必须显式声明（2026-09-21 别名 cue 静默丢失缺陷的反面）。 */
	aliases?: readonly string[];
}

export interface CatalogSlotEntry {
	description: string;
	/** 轴值必须已声明于 rig.controls 且落在 [min,max]，compileCatalog 校验。 */
	values: Readonly<Record<string, number>>;
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

/** 背景循环/思考动作（引擎类别 transition；P4-4 thinking 状态驱动消费）。 */
export interface CatalogBackground {
	thinking?: CompiledMotion;
	idle?: CompiledMotion;
}

/** 不可变目录快照：世界工具词表、endpoint affordance/supportsCue 的同源事实。 */
export interface CatalogSnapshot {
	readonly modelID: string;
	readonly motions: ReadonlyMap<string, CatalogMotionEntry>;
	readonly postures: ReadonlyMap<string, CatalogSlotEntry>;
	readonly expressions: ReadonlyMap<string, CatalogSlotEntry>;
	readonly attentions: ReadonlyMap<string, CatalogAttentionEntry>;
	readonly costumes: readonly CatalogCostumeEntry[];
	readonly background: CatalogBackground;
}

/** 空目录是诚实状态：引擎接入而作者目录未产出时，一切命名参数显式拒绝。 */
export const emptyCatalog = (modelID: string): CatalogSnapshot => ({
	modelID,
	motions: new Map(),
	postures: new Map(),
	expressions: new Map(),
	attentions: new Map(),
	costumes: [],
	background: {},
});

export interface CatalogSource {
	/** 动作输入：definition 即 motion 原始定义（编译产物由 compileCatalog 生成，不进输入）。 */
	motions?: Readonly<
		Record<
			string,
			{
				description: string;
				motion: MotionDefinition;
				atomic?: boolean;
				aliases?: readonly string[];
			}
		>
	>;
	postures?: Readonly<Record<string, CatalogSlotEntry & { description: string }>>;
	expressions?: Readonly<Record<string, CatalogSlotEntry & { description: string }>>;
	attentions?: Readonly<Record<string, CatalogAttentionEntry>>;
	costumes?: readonly CatalogCostumeEntry[];
	background?: { thinking?: MotionDefinition; idle?: MotionDefinition };
}

const take = <T,>(record: Readonly<Record<string, T>> | undefined): Map<string, T> => new Map(Object.entries(record ?? {}));

/**
 * 绑定期编译与校验：动作编译（非法定义即抛）、轴值范围核验、全命名空间唯一性
 * （含内置注视词表与别名占用）。任何失败都阻止模型包装配，不带病上线。
 */
export function compileCatalog(modelID: string, source: CatalogSource, rig: { controls: Readonly<Record<string, RigControlDef>>; modelID: string }): CatalogSnapshot {
	if (rig.modelID !== modelID) throw new Error(`目录模型身份不符: 目录 ${modelID} vs rig ${rig.modelID}`);
	const motions = new Map<string, CatalogMotionEntry>();
	for (const [name, entry] of Object.entries(source.motions ?? {})) {
		motions.set(name, {
			description: entry.description,
			definition: entry.motion,
			motion: compileMotion(entry.motion, rig.controls),
			atomic: entry.atomic ?? true,
			aliases: entry.aliases,
		});
	}
	const validateSlot = (name: string, slot: CatalogSlotEntry, kind: string): void => {
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
	const attentions = take(source.attentions);
	for (const name of attentions.keys()) {
		if ((BUILTIN_ATTENTIONS as readonly string[]).includes(name))
			throw new Error(`注视命名 "${name}" 与引擎内置词表冲突`);
	}
	// 全局唯一命名空间（§2）：动作/姿态/表情/注视/外观 + 别名，重复即语义歧义。
	const owners = new Map<string, string>();
	const claim = (name: string, owner: string): void => {
		const existing = owners.get(name);
		if (existing) throw new Error(`命名冲突: "${name}" 已被 ${existing} 占用（目录命名空间全局唯一）`);
		owners.set(name, owner);
	};
	for (const [name, entry] of motions) {
		claim(name, `动作.${name}`);
		for (const alias of entry.aliases ?? []) claim(alias, `动作.${name}.别名`);
	}
	for (const name of postures.keys()) claim(name, `姿态.${name}`);
	for (const name of expressions.keys()) claim(name, `表情.${name}`);
	for (const name of attentions.keys()) claim(name, `注视.${name}`);
	for (const costume of source.costumes ?? []) claim(costume.id, `外观.${costume.id}`);
	return {
		modelID,
		motions,
		postures,
		expressions,
		attentions,
		costumes: source.costumes ?? [],
		background: {
			thinking: source.background?.thinking ? compileMotion(source.background.thinking, rig.controls) : undefined,
			idle: source.background?.idle ? compileMotion(source.background.idle, rig.controls) : undefined,
		},
	};
}

/** express speech 参数覆写：外层 withSpeech 节点在编译时最后写入 mouth 轨道策略，覆盖作者内层声明。 */
export function recompileWithSpeech(entry: CatalogMotionEntry, policy: SpeechPolicy, controls: Readonly<Record<string, RigControlDef>>): CompiledMotion {
	return compileMotion(withSpeech(entry.definition, policy), controls);
}

/**
 * 格式化目录的紧凑能力摘要（单一真实来源，供事件通知与状态回执复用）。
 */
export function formatCatalogAffordances(catalog: CatalogSnapshot): {
	cuesText: string;
	posturesText: string;
} {
	const cueList = [...catalog.motions.entries()].map(([id, m]) => `${id}(${m.description})`);
	const postureList = [...catalog.postures.entries()].map(([id, p]) => `${id}(${p.description})`);
	return {
		cuesText: cueList.length > 0 ? cueList.join(", ") : "无",
		posturesText: postureList.length > 0 ? postureList.join(", ") : "无",
	};
}
