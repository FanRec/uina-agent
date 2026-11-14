import { errorMessage } from "../core/errors.js";
import type {
	ContextCollection,
	ContextContribution,
	ContextRead,
	ContextSource,
	ContextSourceTraceEntry,
	ContextValue,
} from "../core/types.js";
import type { RuntimeScopeFilter } from "./host.js";

/**
 * Context Source Registry（信息注入重构）：带激活作用域的 Source 注册表。
 *
 * - 实际主键是 `激活作用域 + id`（key = `${owner}::${id}`）；相同激活范围内重名注册
 *   直接拒绝，注销即时撤下。
 * - owner 由注册方注入真实激活身份，扩展无法通过字符串伪造其他扩展的 Source。
 * - collect() 在入口同步固定注册快照：热重载不会把旧 Source 的前半次读取和新 Source
 *   的后半次读取混进同一次收集；已冻结作用域在读取中失效的，省略其贡献并记录注销。
 * - 单个 Source 失败/返回空不阻断其余；失败以 omitted 条目如实记录，不伪装成
 *   "环境无变化"，也不保留上次成功值。
 * - 资源刷新（S2）经 replaceMany 在同一发布边界原位替换现役文件式 Guidance 的文本
 *   与编译元数据：保留 Scope、key 与旧注销句柄的有效性，不建第二套注册表。
 * - 不做语义去重、重要度排序或缓存：当前 Source 返回值就是权威快照，排版归 Composer。
 */

interface RegisteredSource {
	readonly key: string;
	readonly owner: string;
	/** 注册身份令牌：replace 按令牌原位替换，注销句柄凭令牌核对所有权。 */
	readonly token: object;
	/** 可变字段：replaceMany 原位替换该对象（同一同步边界内完成，不跨 await 半更新）。 */
	source: ContextSource;
	/** 读取完成后再核一次活性：冻结作用域的贡献必须整条省略，不得半新半旧。 */
	readonly isActive: () => boolean;
}

/** 注册边界校验：结构问题当场拒绝（扩展作者立即可见），不做更深的语义判断。 */
export function validateContextSource(source: ContextSource): void {
	if (!source || typeof source !== "object") throw new Error("ContextSource 必须是对象");
	if (typeof source.id !== "string" || !source.id.trim()) throw new Error("ContextSource.id 不能为空");
	// "::" 是注册键分隔符（key = `${owner}::${id}`）：id 含分隔符会让 key 无法唯一还原，
	// 也在来源展示里伪造 owner/id 边界。
	if (source.id.includes("::")) throw new Error('ContextSource.id 不能包含 "::"（保留为注册键分隔符）');
	if (source.kind === "guidance") {
		if (typeof source.text !== "string" || !source.text.trim())
			throw new Error("guidance Source 的 text 不能为空（稳定指引在注册时确定）");
		if (source.requiresTool !== undefined && (typeof source.requiresTool !== "string" || !source.requiresTool.trim()))
			throw new Error("guidance Source 的 requiresTool 必须是非空工具名");
		return;
	}
	if (source.kind !== "observation")
		throw new Error(`未知 ContextSource kind: ${String((source as { kind?: unknown }).kind)}`);
	if (typeof source.read !== "function") throw new Error(`${source.kind} Source 必须提供 read(ctx)`);
}

/** 资源刷新的原位替换项：目标注册令牌 + 替换后的 Source。 */
export interface ContextSourceReplacement {
	readonly token: object;
	readonly next: ContextSource;
}

export class ContextSourceRegistry {
	private readonly sources = new Map<string, RegisteredSource>();

	/** 注册一个 Source；返回注销句柄。同 owner+id 重复注册直接拒绝。 */
	register(owner: string, source: ContextSource, isActive: () => boolean): () => void {
		validateContextSource(source);
		if (owner.includes("::")) throw new Error(`激活身份不能包含 "::": ${owner}`);
		const key = contextSourceKey(owner, source.id);
		if (this.sources.has(key)) {
			throw new Error(`Context Source 重名: ${key}（同一激活范围内 id 必须唯一）`);
		}
		const entry: RegisteredSource = { key, owner, token: {}, source, isActive };
		this.sources.set(key, entry);
		return () => {
			const current = this.sources.get(key);
			if (current && current.token === entry.token) this.sources.delete(key);
		};
	}

	/**
	 * 按注册键反查替换令牌（资源刷新登记用）。未注册返回 undefined。
	 */
	tokenOf(owner: string, id: string): object | undefined {
		return this.sources.get(contextSourceKey(owner, id))?.token;
	}

	/** 按注册键反查当前 Source（资源刷新捕获回滚基线用）。未注册返回 undefined。 */
	sourceOf(owner: string, id: string): ContextSource | undefined {
		return this.sources.get(contextSourceKey(owner, id))?.source;
	}

	/** 现役文件式 Guidance 的编译指纹（资源版本计算用），按 key 稳定排序。
	 * 只有携带编译元数据（文件式注册）的 guidance 参与；内联注册无指纹。 */
	promptHashes(): readonly { key: string; hash: string }[] {
		const hashes: { key: string; hash: string }[] = [];
		for (const [key, entry] of this.sources) {
			if (entry.source.kind === "guidance" && entry.source.prompt) {
				hashes.push({ key, hash: entry.source.prompt.hash });
			}
		}
		return hashes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	/**
	 * 资源刷新的发布边界（S2）：按注册令牌原位替换现役 Source（文本与编译元数据）。
	 * 同步执行、不跨 await——发布中途不存在半更新的 Registry。任一令牌已注销
	 * （Scope 被卸载）则整批拒绝：被卸载的 Scope 不参与刷新，不留部分替换。
	 */
	replaceMany(replacements: readonly ContextSourceReplacement[]): void {
		const targets: RegisteredSource[] = [];
		for (const replacement of replacements) {
			const entry = [...this.sources.values()].find((candidate) => candidate.token === replacement.token);
			if (!entry) {
				throw new Error(`资源刷新目标已注销，整批替换保留旧版本: ${replacement.next.id}`);
			}
			validateContextSource(replacement.next);
			targets.push(entry);
		}
		// 全部校验通过后才落替换：同一次发布边界内原子。
		for (let index = 0; index < replacements.length; index++) {
			targets[index]!.source = replacements[index]!.next;
		}
	}

	/**
	 * 只读收集一次快照。guidance 直接给注册文本；动态 Source 并行 read，但结果统一按
	 * 快照顺序交出（Composer 再次按 key 排序，不依赖 Promise 完成次序）。
	 */
	async collect(input: Readonly<ContextRead>, scope?: RuntimeScopeFilter): Promise<ContextCollection> {
		// 注册快照在入口同步固定：collect 进行期间的注册/注销/替换不影响本次可见集合。
		const snapshot = [...this.sources.values()].filter((entry) => visible(entry.owner, scope));
		const contributions: ContextContribution[] = [];
		const omitted: ContextSourceTraceEntry[] = [];

		await Promise.all(
			snapshot.map(async (entry): Promise<void> => {
				const traceBase = { key: entry.key, owner: entry.owner, id: entry.source.id };
				try {
					if (!entry.isActive()) {
						omitted.push({ ...traceBase, kind: entry.source.kind, status: "unregistered", reason: "扩展已注销" });
						return;
					}
					if (entry.source.kind === "guidance") {
						// requiresTool 条件：本次请求声明的工具不含该名称时省略（普通省略
						// 诊断）。保证 Guidance 与同一次最终请求的工具声明一致。
						if (
							entry.source.requiresTool !== undefined &&
							!(input.availableToolNames ?? []).includes(entry.source.requiresTool)
						) {
							omitted.push({
								...traceBase,
								kind: "guidance",
								status: "empty",
								reason: `requiresTool 未在本次工具声明中: ${entry.source.requiresTool}`,
							});
							return;
						}
						// guidance 是注册时确定的同步文本：活性已在入口核过，直接给出。
						// 文件式注册的编译元数据随贡献透传（诊断对账用，不参与装配语义）。
						contributions.push({
							key: entry.key,
							owner: entry.owner,
							kind: "guidance",
							value: { text: entry.source.text },
							...(entry.source.prompt ? { prompt: entry.source.prompt } : {}),
						});
						return;
					}
					const value = await entry.source.read({ modelKey: input.modelKey, signal: input.signal });
					// read 可能跨越 await：返回后再核活性，冻结作用域的贡献不得混入本请求。
					if (!entry.isActive()) {
						omitted.push({
							...traceBase,
							kind: entry.source.kind,
							status: "unregistered",
							reason: "Source 所在扩展在读取完成前已注销",
						});
						return;
					}
					if (value === null || value === undefined) {
						omitted.push({
							...traceBase,
							kind: entry.source.kind,
							status: "empty",
							reason: "read() 返回 null（本次没有贡献）",
						});
						return;
					}
					if (typeof value !== "object" || typeof (value as ContextValue).text !== "string") {
						omitted.push({
							...traceBase,
							kind: entry.source.kind,
							status: "error",
							reason: "read() 返回了不合法的 ContextValue",
						});
						return;
					}
					contributions.push({ key: entry.key, owner: entry.owner, kind: entry.source.kind, value });
				} catch (error) {
					omitted.push({
						...traceBase,
						kind: entry.source.kind,
						status: "error",
						reason: errorMessage(error),
					});
				}
			}),
		);

		return { contributions, omitted };
	}
}

function contextSourceKey(owner: string, id: string): string {
	return `${owner}::${id}`;
}

function visible(owner: string, scope: RuntimeScopeFilter): boolean {
	if (scope === undefined) return true;
	return scope.includes(owner);
}
