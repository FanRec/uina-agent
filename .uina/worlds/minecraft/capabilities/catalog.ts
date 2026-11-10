/**
 * 能力目录：静态声明的一次性校验、索引与绑定。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3–§4。
 * 模块（MinecraftCapabilityModule）自带 descriptor 与 bind 的配对，目录在创建时
 * 完成全部结构校验（id/ref 唯一、schema 可编译）——无效模块显式拒绝激活，
 * 不静默替换已有能力。bind(deps) 只在 Companion 初始化时调用，产生读写实现；
 * descriptors() 不依赖任何 deps，无连接、无执行域即可列出全部能力。
 * 查询与动作共用一个 ref 命名空间：describe selector 不区分两类，目录也不区分。
 */

import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type {
	CallableDescriptor,
	NativeCallable,
	ProgramCallable,
	QueryDescriptor,
	QueryReader,
	QueryValidator,
} from "../contracts/capabilities.js";
import type { ExactRef, JsonValue, Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { parseProgramSource } from "../library/program-source.js";
import type { CapabilityDeps } from "./deps.js";

/** 动作绑定只返回 invoke；最终 NativeCallable 由目录用同一 descriptor 组装。 */
export type CapabilityInvoke = NativeCallable<JsonValue, JsonValue>["invoke"];

export type CapabilityDefinition =
	| { kind: "query"; descriptor: QueryDescriptor; bind(deps: CapabilityDeps): QueryReader | null }
	| { kind: "action"; descriptor: CallableDescriptor; bind(deps: CapabilityDeps): CapabilityInvoke }
	| { kind: "program"; descriptor: CallableDescriptor; source: string; recoveryCheck?: ExactRef; publishSource?: true };

export interface MinecraftCapabilityModule {
	id: string;
	definitions: readonly CapabilityDefinition[];
}

export interface BuiltCapabilities {
	/** 查询目录（含由 World 实现读取的 events@1）。 */
	queries: QueryDescriptor[];
	/** World 读取表：只含有当前/静态读取方式的查询。 */
	readers: ReadonlyMap<ExactRef, QueryReader>;
	/** World executes this boundary before any current/static/history dispatch. */
	validators: ReadonlyMap<ExactRef, QueryValidator>;
	callables: NativeCallable<JsonValue, JsonValue>[];
	programs: ProgramCallable[];
	refs: Ref[];
}

interface AjvLike {
	compile(schema: Record<string, unknown>): ValidateFunction;
	errorsText(errors?: ValidateFunction["errors"]): string;
}
const AjvCtor = createRequire(import.meta.url)("ajv") as new (options: {
	strict: boolean;
	allErrors: boolean;
	addUsedSchema?: boolean;
}) => AjvLike;

function queryValidator(ref: ExactRef, ajv: AjvLike, validate: ValidateFunction): QueryValidator {
	return (raw) => {
		const normalized = raw ?? {};
		if (!validate(normalized))
			throw callFailure({
				code: "INVALID_INPUT",
				source: "input",
				message: `${ref} input rejected: ${ajv.errorsText(validate.errors)}`,
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		return normalized;
	};
}

function freezeContract<T>(value: T): T {
	if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const member of Object.values(value)) freezeContract(member);
	}
	return value;
}

export class CapabilityCatalog {
	private readonly defs: readonly CapabilityDefinition[];
	private readonly descriptors: readonly (QueryDescriptor | CallableDescriptor)[];
	private readonly queryValidators: ReadonlyMap<ExactRef, QueryValidator>;

	private constructor(modules: readonly MinecraftCapabilityModule[]) {
		const ajv = new AjvCtor({ strict: false, allErrors: true, addUsedSchema: false });
		const defs: CapabilityDefinition[] = [];
		const seenIds = new Set<string>();
		const byRef = new Map<string, CapabilityDefinition>();
		const validators = new Map<ExactRef, QueryValidator>();
		for (const module of modules) {
			if (module.id.length === 0) throw new Error("capability module id must not be empty");
			if (seenIds.has(module.id)) throw new Error(`duplicate capability module id: ${module.id}`);
			seenIds.add(module.id);
			for (const contribution of module.definitions) {
				const definition = {
					...contribution,
					descriptor: freezeContract(structuredClone(contribution.descriptor)),
				} as CapabilityDefinition;
				const { ref } = definition.descriptor;
				if (byRef.has(ref)) throw new Error(`duplicate capability ref: ${ref}`);
				byRef.set(ref, definition);
				if (definition.kind === "query") {
					if (definition.descriptor.access !== "read") throw new Error(`query ${ref} must declare access "read"`);
					try {
						validators.set(
							ref,
							queryValidator(ref, ajv, ajv.compile(definition.descriptor.input as Record<string, unknown>)),
						);
					} catch (error) {
						throw new Error(`query ${ref} input schema rejected: ${String(error)}`);
					}
				} else if (definition.descriptor.access !== "act") {
					throw new Error(`action ${ref} must declare access "act"`);
				} else {
					// 动作输入校验在 Runtime 受理处按 descriptor.inputSchema 执行；
					// 这里只做"schema 可编译"的激活门——坏 schema 拒绝激活而不是首调才炸。
					try {
						ajv.compile(definition.descriptor.input as Record<string, unknown>);
					} catch (error) {
						throw new Error(`action ${ref} input schema rejected: ${String(error)}`);
					}
				}
				defs.push(definition);
			}
		}
		for (const definition of defs) {
			if (
				definition.kind === "program" &&
				definition.recoveryCheck &&
				byRef.get(definition.recoveryCheck)?.kind !== "query"
			)
				throw new Error(`program ${definition.descriptor.ref} requires recovery query ${definition.recoveryCheck}`);
		}
		this.defs = defs;
		this.descriptors = Object.freeze(defs.map((definition) => definition.descriptor));
		this.queryValidators = validators;
	}

	static create(modules: readonly MinecraftCapabilityModule[]): CapabilityCatalog {
		return new CapabilityCatalog(modules);
	}

	/** 静态目录：不依赖 deps、不触发 bind，无连接即可发现。 */
	allDescriptors(): readonly (QueryDescriptor | CallableDescriptor)[] {
		return this.descriptors;
	}

	publishedPrograms(): ExactRef[] {
		return this.defs.flatMap((definition) =>
			definition.kind === "program" && definition.publishSource ? [definition.descriptor.ref] : [],
		);
	}

	publishedSource(selector: string): { source: string; digest: string } | null {
		const definition = this.defs.find((candidate) => candidate.descriptor.ref === selector);
		if (definition?.kind !== "program" || !definition.publishSource) return null;
		const { source, digest } = parseProgramSource(definition.source, null);
		return { source, digest };
	}

	/** 产生读写实现（仅 Companion 初始化调用；deps 为惰性注入，不做任何探测）。 */
	bind(deps: CapabilityDeps): BuiltCapabilities {
		const queries: QueryDescriptor[] = [];
		const readers = new Map<ExactRef, QueryReader>();
		const callables: NativeCallable<JsonValue, JsonValue>[] = [];
		const programs: ProgramCallable[] = [];
		const actionRefs: Ref[] = [];
		for (const definition of this.defs) {
			if (definition.kind === "query") {
				queries.push(definition.descriptor);
				const reader = definition.bind(deps);
				if (reader != null) readers.set(definition.descriptor.ref, reader);
			} else {
				actionRefs.push(definition.descriptor.ref);
				if (definition.kind === "program")
					programs.push({
						descriptor: definition.descriptor,
						program: freezeContract(parseProgramSource(definition.source, null)),
						recoveryCheck: definition.recoveryCheck,
					});
				else callables.push({ descriptor: definition.descriptor, invoke: definition.bind(deps) });
			}
		}
		return { queries, readers, validators: this.queryValidators, callables, programs, refs: actionRefs };
	}
}
