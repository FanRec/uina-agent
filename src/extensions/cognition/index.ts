/**
 * 认知扩展阶段 B / M4：记忆工具面。
 *
 * 不变量：模型只见 ID 与 query，不见路径、subjectId 或其他主体的任何标识。
 * - 工具 schema 中不存在 subjectId/路径参数——隔离边界由构造注入，不给模型留口子；
 * - scope 由绑定上下文注入（当前实现：主体默认作用域），不从模型参数读；
 * - 服务层 committed/conflict/rejected 适配为真实工具五态：
 *   committed → succeeded；conflict/rejected → failed（版本冲突不报告"记住了"）；
 *   写入抛异常 → unknown（不猜测未确认结果）。
 */

import type { Tool } from "../../tools/broker.js";
import { createMemoryStore, type MemoryStore, type MemoryStoreOptions, type MemoryChange } from "./memory.js";

export { createMemoryStore, type MemoryStore, type MemoryStoreOptions, type MemoryChange } from "./memory.js";

/** 记忆行为协议（政策层，随 cognition 激活常驻 systemPrompt）。
 *  机制细节（hash/committed/conflict 返回语义）由三工具的 description 承载，
 *  两处分工不重复：system 管"何时写、如何对待事实"，工具描述管"怎么调、返回什么"。 */
export const MEMORY_PROTOCOL_PROMPT = `# 记忆纪律
长期记忆跨会话存续，只属于你。写入有据：sources 必须来自本会话真实历史，或 basis=inferred 并附依据；不编造来源，不把转述算多份证据。
你的笔记是可修订的理解，不是已验证事实：basis 如实标注，引用时说明来源。
修订基于 memory_read 的当前 hash；conflict 表示有并发更新，重读后决定，不覆盖不盲试。
节制写入：只记值得跨会话保留的（偏好、承诺、修正后的认识、有效方法），没有就正常回答。
回忆不起就承认回忆不起。彻底遗忘走 retire 加用户确认。`;

/** 服务层三态 → 工具五态的正文承载：JSON 字符串，模型可解析 hash/当前版本。 */
function adaptResult(
	id: string | undefined,
	result: Awaited<ReturnType<MemoryStore["write"]>>,
): { result: string; status: "succeeded" | "failed" } {
	if (result.status === "committed") {
		return {
			result: JSON.stringify({ status: "committed", id: result.id, hash: result.hash, revision: result.revision }),
			status: "succeeded",
		};
	}
	return {
		result: JSON.stringify({
			status: result.status,
			...(id ? { id } : {}),
			...(result.status === "conflict" ? { currentHash: result.currentHash } : {}),
			reason: result.reason,
		}),
		status: "failed",
	};
}

// 只对 create 盖戳：create 的来源集全部由本次写入者提供，语义明确。
// revise 的 sources 是全量替换集，无法区分「新增来源」与「从 memory_read 回传的旧来源」，
// 一律盖戳会把旧来源误标为当前写入者——provenance 不撒谎，宁缺毋错。
function annotateChildMemoryChange(change: MemoryChange, agentId: string): MemoryChange {
	if (change.op !== "create") return change;
	return {
		...change,
		record: { ...change.record, sources: change.record.sources.map((source) => ({ ...source, agentId })) },
	};
}

/**
 * 认知能力工厂：由 Host/测试以绑定资源装配。
 * 记忆工具可操作的范围由绑定上下文决定——这是唯一合法的路径/主体来源。
 */
export interface CognitionCapabilityOptions extends MemoryStoreOptions {
	memoryStore?: MemoryStore;
}

export function createCognitionCapability(options: CognitionCapabilityOptions): { store: MemoryStore; tools: Tool[] } {
	const store = options.memoryStore ?? createMemoryStore(options);
	return { store, tools: createMemoryTools(store) };
}

/** 由 MemoryStore 构造三工具。store 的绑定已封闭，工具 schema 无身份参数。 */
export function createMemoryTools(store: MemoryStore): Tool[] {
	const memorySearch: Tool = {
		def: {
			type: "function",
			function: {
				name: "memory_search",
				description: "检索当前主体长期记忆；先用它找 ID/摘要，再用 memory_read 核实完整内容。只读，不修改记忆。",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "检索关键词或片段（支持中文，无需分词）" },
						limit: { type: "integer", minimum: 1, maximum: 100, description: "最多返回的命中数；省略使用默认上限" },
					},
					required: ["query"],
					additionalProperties: false,
				},
			},
		},
		async run(args) {
			const query = String(args.query ?? "");
			const limit = typeof args.limit === "number" ? args.limit : 50;
			const hits = (await store.search(query, {})).slice(0, limit);
			if (hits.length === 0) {
				return { result: JSON.stringify({ hits: [] }), status: "succeeded" };
			}
			return {
				result: JSON.stringify({
					hits: hits.map((h) => ({
						id: h.id,
						title: h.title,
						excerpt: h.excerpt,
						revision: h.revision,
						hash: h.hash,
					})),
				}),
				status: "succeeded",
			};
		},
	};

	const memoryRead: Tool = {
		def: {
			type: "function",
			function: {
				name: "memory_read",
				description:
					"读取 memory_search/memory_write 返回的记忆 ID，核实正文、来源、scope 和当前 hash；不修改记忆。正文很长时使用 max_chars。",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "记忆 ID（memory_search 返回的 id）" },
						max_chars: { type: "integer", minimum: 1, maximum: 200_000, description: "可选正文上限；省略返回完整内容" },
					},
					required: ["id"],
					additionalProperties: false,
				},
			},
		},
		async run(args) {
			const id = String(args.id ?? "");
			const record = await store.read(id);
			if (!record) {
				return { result: JSON.stringify({ error: `记忆不存在或已遗忘：${id}` }), status: "failed" };
			}
			const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined;
			const body = maxChars === undefined ? record.body : record.body.slice(0, maxChars);
			return {
				result: JSON.stringify({
					id: record.id,
					title: record.title,
					body,
					...(maxChars !== undefined && body.length < record.body.length
						? { truncated: true, next: { tool: "memory_read", id, max_chars: maxChars * 2 } }
						: {}),
					type: record.type,
					basis: record.basis,
					scope: record.scope,
					sources: record.sources,
					status: record.status,
					revision: record.revision,
					hash: record.hash,
				}),
				status: "succeeded",
			};
		},
	};

	const memoryWrite: Tool = {
		def: {
			type: "function",
			function: {
				name: "memory_write",
				description:
					"写入、修订或退休长期记忆。写前先核实来源；revise/retire 必须使用 memory_read 的当前 hash。conflict 不覆盖，重新读取后再决定；异常结果未知时不要盲重试。",
				parameters: {
					type: "object",
					properties: {
						operation: {
							type: "object",
							description: "记忆变更操作",
							oneOf: [
								{
									type: "object",
									properties: {
										op: { type: "string", const: "create" },
										record: {
											type: "object",
											properties: {
												type: { type: "string", enum: ["note", "commitment", "procedure"] },
												basis: { type: "string", enum: ["observed", "reported", "inferred"] },
												title: { type: "string" },
												body: { type: "string" },
												scope: {
													type: "object",
													properties: {
														spaceId: { type: "string" },
														projectId: { type: "string" },
														actorId: { type: "string" },
													},
													additionalProperties: false,
												},
												sources: {
													type: "array",
													items: {
														type: "object",
														properties: {
															sessionId: { type: "string" },
															entryId: { type: "string" },
															note: { type: "string" },
														},
														required: ["sessionId"],
														additionalProperties: false,
													},
												},
												rationale: { type: "string" },
												pinned: { type: "boolean" },
											},
											required: ["type", "basis", "title", "body", "scope", "sources", "pinned"],
											additionalProperties: false,
										},
									},
									required: ["op", "record"],
									additionalProperties: false,
								},
								{
									type: "object",
									properties: {
										op: { type: "string", const: "revise" },
										id: { type: "string" },
										expectedHash: { type: "string" },
										record: {
											type: "object",
											properties: {
												title: { type: "string" },
												body: { type: "string" },
												scope: {
													type: "object",
													properties: {
														spaceId: { type: "string" },
														projectId: { type: "string" },
														actorId: { type: "string" },
													},
													additionalProperties: false,
												},
												sources: {
													type: "array",
													items: {
														type: "object",
														properties: {
															sessionId: { type: "string" },
															entryId: { type: "string" },
															note: { type: "string" },
														},
														required: ["sessionId"],
														additionalProperties: false,
													},
												},
												rationale: { type: "string" },
												pinned: { type: "boolean" },
											},
											additionalProperties: false,
										},
									},
									required: ["op", "id", "expectedHash", "record"],
									additionalProperties: false,
								},
								{
									type: "object",
									properties: {
										op: { type: "string", const: "retire" },
										id: { type: "string" },
										expectedHash: { type: "string" },
										reason: { type: "string" },
									},
									required: ["op", "id", "expectedHash", "reason"],
									additionalProperties: false,
								},
							],
						},
					},
					required: ["operation"],
					additionalProperties: false,
				},
			},
		},
		async run(args, _signal, context) {
			const operation = args.operation as MemoryChange;
			if (!operation || typeof operation !== "object" || !("op" in operation)) {
				return { result: JSON.stringify({ status: "rejected", reason: "缺少 operation" }), status: "failed" };
			}
			const id = "id" in operation ? String(operation.id) : undefined;
			try {
				const ownerId = context?.ownerId;
				const writeOperation =
					ownerId && ownerId !== "root" ? annotateChildMemoryChange(operation, ownerId) : operation;
				const result = await store.write(writeOperation);
				return adaptResult(id, result);
			} catch (error) {
				// writer 内部异常：不猜测结果（unknown），明确上报。
				return {
					result: JSON.stringify({
						status: "unknown",
						...(id ? { id } : {}),
						reason: `写入未确认，请用 memory_read 核实后再试：${String(error)}`,
					}),
					status: "unknown",
				};
			}
		},
	};

	return [memorySearch, memoryRead, memoryWrite];
}
