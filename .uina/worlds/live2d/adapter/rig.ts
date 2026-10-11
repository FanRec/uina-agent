/**
 * ModelRig v3：手工模型控制配置的 schema、校验与标尺采样（P1-1）。
 *
 * rig 是**可验证的数据**，不是代码：一个逻辑控制在这个模型上如何运动、谁负责写它。
 * 本模块只做模型无关校验（曲线形状、输入归属、聚合规则声明）；与真实模型事实
 * （参数存在性、真实范围、跟随关系）的绑定核验属于 profile 侧（P1-2 的编译步骤）。
 *
 * 依据：引擎规范 v4.6 §3.1 + 修订登记 A6（v1 仅实现 max）/ A7（升 v3、optional 轴）。
 * 坐标契约：rigTarget.points 是 Layer 1（逻辑轴值）→ Layer 2（VTS 输入值）的分段线性
 * 标尺，超出首尾关键点**强制端点裁剪**，严禁外推。
 */

export type MappingEvidence = "input-only" | "declared" | "observed" | "calibrated";

/** 逻辑控制定义。optional: true 表示模型可以合法缺少该通道（降级执行，见修订 A13）。 */
export interface RigControlDef {
	min: number;
	max: number;
	neutral: number;
	optional?: true;
}

/** 单个绑定目标：一个逻辑轴在一个 VTS 输入上的写法。 */
export interface RigTarget {
	/** 期望驱动的 Cubism 输出参数名（如 ParamAngleX），用于存在性核验与读回诊断。 */
	parameter: string;
	/** 对应的 VTS 虚拟追踪输入参数名（如 FaceAngleX）。 */
	input: string;
	/** 标定曲线：[逻辑值, 输入值] 分段线性标尺，首尾端点必须覆盖 [min, max]。 */
	points: readonly (readonly [number, number])[];
	/** 除主动输出外的直接扇出（同输入映射的其他 Cubism 参数）。 */
	followers: readonly string[];
	/** 作者确认接受的传递性非零物理输出。 */
	physicsFollowers: readonly string[];
	smoothing: number;
	evidence?: MappingEvidence;
}

/**
 * 多逻辑轴汇入同一 VTS 输入的聚合规则（按输入名声明）。
 * 实现 max（同向非负量取最大）与 weighted（多轴加权归一化聚合）；primary 仅保留类型，声明即绑定期报错。
 */
export type RetargetingRule =
	| { readonly strategy: "max" }
	| { readonly strategy: "weighted"; readonly weights: Readonly<Record<string, number>> }
	| { readonly strategy: "primary"; readonly primaryAxis: string; readonly deadzone?: number };

export interface ModelRig {
	version: 3;
	modelID: string;
	controls: Readonly<Record<string, RigControlDef>>;
	bindings: Readonly<Record<string, readonly RigTarget[]>>;
	/** 以 VTS 输入参数名为键；多轴汇入同一输入时必须显式声明，未声明者绑定期报错。 */
	retargeting?: Readonly<Record<string, RetargetingRule>>;
	/** 外部主来源声明：若为 "vts"，Uina 自律发生器对相应通道静默，杜绝双重叠加。 */
	external: { blink: "vts" | "uina" | "none"; breath: "vts" | "none" };
}

export class RigValidationError extends Error {}

const EVIDENCE: readonly MappingEvidence[] = ["input-only", "declared", "observed", "calibrated"];

const finite = (value: number): boolean => Number.isFinite(value);

/** 校验 ModelRig v3 的模型无关事实。全部通过即返回；任何问题抛 RigValidationError。 */
export function validateRig(rig: ModelRig): void {
	if (!rig || typeof rig !== "object") throw new RigValidationError("rig 必须是对象");
	if (rig.version !== 3) throw new RigValidationError(`ModelRig 版本错误: 期望 3，收到 ${String(rig.version)}`);
	if (!rig.modelID || typeof rig.modelID !== "string") throw new RigValidationError("缺少 modelID");
	if (!rig.controls || typeof rig.controls !== "object") throw new RigValidationError("缺少 controls");
	if (!rig.bindings || typeof rig.bindings !== "object") throw new RigValidationError("缺少 bindings");
	validateExternal(rig.external);

	const inputsWritten = new Map<string, Set<string>>();
	for (const [axis, control] of Object.entries(rig.controls)) {
		validateControl(axis, control);
	}
	for (const [axis, targets] of Object.entries(rig.bindings)) {
		const control = rig.controls[axis];
		if (!control) throw new RigValidationError(`绑定引用未声明控制: ${axis}`);
		if (!Array.isArray(targets) || targets.length === 0) throw new RigValidationError(`缺少手工绑定: ${axis}`);
		for (const target of targets) {
			validateTarget(axis, control, target);
			const writers = inputsWritten.get(target.input) ?? new Set<string>();
			writers.add(axis);
			inputsWritten.set(target.input, writers);
		}
	}
	for (const axis of Object.keys(rig.controls)) {
		if (!rig.bindings[axis]) throw new RigValidationError(`缺少手工绑定: ${axis}`);
	}
	validateRetargeting(rig, inputsWritten);
}

function validateExternal(external: ModelRig["external"]): void {
	const sources: readonly string[] = ["vts", "uina", "none"];
	if (!external || !sources.includes(external.blink) || !sources.includes(external.breath)) {
		throw new RigValidationError("external.blink / external.breath 必须是 vts | uina | none");
	}
}

function validateControl(axis: string, control: RigControlDef): void {
	if (![control.min, control.max, control.neutral].every(finite)) throw new RigValidationError(`非法控制范围: ${axis}`);
	if (control.min >= control.max) throw new RigValidationError(`控制范围倒置: ${axis}`);
	if (control.neutral < control.min || control.neutral > control.max) {
		throw new RigValidationError(`中性值越界: ${axis}`);
	}
}

function validateTarget(axis: string, control: RigControlDef, target: RigTarget): void {
	if (!target || typeof target !== "object") throw new RigValidationError(`绑定目标缺失: ${axis}`);
	if (!target.input || typeof target.input !== "string") throw new RigValidationError(`缺少输入名: ${axis}`);
	if (!target.parameter || typeof target.parameter !== "string") throw new RigValidationError(`缺少输出参数名: ${axis}`);
	if (!finite(target.smoothing) || target.smoothing < 0 || target.smoothing > 1) {
		throw new RigValidationError(`非法平滑系数: ${axis}`);
	}
	if (target.evidence !== undefined && !EVIDENCE.includes(target.evidence)) {
		throw new RigValidationError(`非法能力证据: ${axis} = ${String(target.evidence)}`);
	}
	validateCurve(axis, control, target.points);
}

/** 曲线形状：完整覆盖 [min,max]、严格单调、中性点必须落在曲线上。 */
function validateCurve(axis: string, control: RigControlDef, points: unknown): void {
	if (!Array.isArray(points) || points.length < 2) throw new RigValidationError(`缺少完整手工曲线: ${axis}`);
	const sign = Math.sign((points.at(-1)?.[1] ?? 0) - (points[0]?.[1] ?? 0));
	for (const [index, point] of points.entries()) {
		if (!Array.isArray(point) || point.length !== 2 || !point.every(finite)) {
			throw new RigValidationError(`非法手工曲线: ${axis}[${index}]`);
		}
		const [x, y] = point as [number, number];
		if (x < control.min || x > control.max) throw new RigValidationError(`曲线越出控制范围: ${axis}[${index}]`);
		if (index > 0) {
			const [previousX, previousY] = points[index - 1] as [number, number];
			if (x <= previousX) throw new RigValidationError(`曲线 x 非严格递增: ${axis}[${index}]`);
			if (sign === 0 || sign * (y - previousY) <= 0) throw new RigValidationError(`曲线 y 方向不一致: ${axis}[${index}]`);
		}
	}
	if ((points[0] as [number, number])[0] !== control.min || (points.at(-1) as [number, number])[0] !== control.max) {
		throw new RigValidationError(`曲线端点必须覆盖 [min, max]: ${axis}`);
	}
	if (!points.some((point) => point[0] === control.neutral)) {
		throw new RigValidationError(`中性点不在曲线上: ${axis}`);
	}
}

function validateRetargeting(rig: ModelRig, inputsWritten: Map<string, Set<string>>): void {
	const declared = rig.retargeting ?? {};
	for (const [input, rule] of Object.entries(declared)) {
		const writers = inputsWritten.get(input);
		if (!writers) throw new RigValidationError(`retargeting 规则指向未被写入的输入: ${input}`);
		if (writers.size <= 1) throw new RigValidationError(`单轴汇入无需声明 retargeting 规则: ${input}`);
		if (rule.strategy === "weighted") {
			if (!rule.weights || typeof rule.weights !== "object") {
				throw new RigValidationError(`weighted 规则缺少 weights: ${input}`);
			}
			let sum = 0;
			for (const axis of writers) {
				const w = rule.weights[axis];
				if (w === undefined || !finite(w) || w < 0) {
					throw new RigValidationError(`weighted 规则轴权重非法: ${input}.${axis}`);
				}
				sum += w;
			}
			if (sum <= 0) {
				throw new RigValidationError(`weighted 规则总权重必须大于 0: ${input}`);
			}
		} else if (rule.strategy !== "max") {
			throw new RigValidationError(`retargeting_not_implemented: ${input} 声明了 ${rule.strategy}，该策略推迟（修订 A6）`);
		}
	}
	for (const [input, writers] of inputsWritten) {
		if (writers.size > 1 && !declared[input]) {
			throw new RigValidationError(`多轴汇入同一输入但未声明 retargeting 规则: ${input} <- ${[...writers].join(", ")}`);
		}
	}
}

/** 分段线性标尺采样：首尾之外强制端点裁剪（Clamp），严禁外推。 */
export function scaleWithClamp(points: readonly (readonly [number, number])[], value: number): number {
	if (value <= points[0]![0]) return points[0]![1];
	if (value >= points.at(-1)![0]) return points.at(-1)![1];
	for (let index = 1; index < points.length; index++) {
		const [startX, startY] = points[index - 1] as [number, number];
		const [endX, endY] = points[index] as [number, number];
		if (value <= endX) return startY + ((endY - startY) * (value - startX)) / (endX - startX);
	}
	return points.at(-1)![1];
}

/**
 * 解析单个 VTS 输入在当前帧的注入值。
 * 单轴直写：按该轴标尺缩放；多轴汇入：按声明的 max 规则取缩放值最大（同向非负量契约）。
 * 调用方保证 rig 已通过 validateRig。
 */
export function resolveInputValue(
	rig: ModelRig,
	input: string,
	frame: Readonly<Record<string, number>>,
): number {
	const writers: Array<{ axis: string; points: readonly (readonly [number, number])[] }> = [];
	for (const [axis, targets] of Object.entries(rig.bindings)) {
		for (const target of targets) {
			if (target.input === input) writers.push({ axis, points: target.points });
		}
	}
	if (writers.length === 0) throw new RigValidationError(`没有控制写入该输入: ${input}`);
	const mapped = writers.map(({ axis, points }) => {
		const value = frame[axis] ?? rig.controls[axis]!.neutral;
		return scaleWithClamp(points, value);
	});
	const rule = rig.retargeting?.[input];
	if (writers.length === 1 || !rule) return mapped[0]!;
	if (rule.strategy === "weighted") {
		let totalWeight = 0;
		let weightedSum = 0;
		for (const { axis, points } of writers) {
			const value = frame[axis] ?? rig.controls[axis]!.neutral;
			const scaled = scaleWithClamp(points, value);
			const w = rule.weights[axis] ?? 0;
			weightedSum += scaled * w;
			totalWeight += w;
		}
		return totalWeight > 0 ? weightedSum / totalWeight : mapped[0]!;
	}
	return Math.max(...mapped);
}

/** 全中性逻辑帧：每个控制取其 neutral 值。保活续租与 safeStop 保持帧的基座来源。 */
export function neutralFrame(rig: ModelRig): Record<string, number> {
	return Object.fromEntries(Object.entries(rig.controls).map(([axis, control]) => [axis, control.neutral]));
}

/**
 * 逻辑帧 → VTS 注入帧：每个被绑定写入的输入按标尺采样一次
 * （多轴汇入同一输入时按声明规则聚合，见 resolveInputValue）。
 * 返回结构与 vts-client 的 VTSParamValue 结构兼容但此处不依赖它——rig 层保持无传输依赖。
 * 调用方保证 rig 已通过 validateRig。
 */
export function encodeFrame(rig: ModelRig, frame: Readonly<Record<string, number>>): { id: string; value: number }[] {
	const inputs = new Set<string>();
	for (const targets of Object.values(rig.bindings)) for (const target of targets) inputs.add(target.input);
	return [...inputs].map((input) => ({ id: input, value: resolveInputValue(rig, input, frame) }));
}
