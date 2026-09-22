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
import {
	createMemoryStore,
	type MemoryStore,
	type MemoryStoreOptions,
	type MemoryChange,
} from "./memory.js";

export { createMemoryStore, type MemoryStore, type MemoryStoreOptions, type MemoryChange } from "./memory.js";

/** 服务层三态 → 工具五态的正文承载：JSON 字符串，模型可解析 hash/当前版本。 */
function adaptResult(id: string | undefined, result: Awaited<ReturnType<MemoryStore["write"]>>): { result: string; status: "succeeded" | "failed" } {
	if (result.status === "committed") {
		return {
			result: JSON.stringify({ status: "committed", id: result.id, hash: result.hash, revision: result.revision }, null, "\t"),
			status: "succeeded",
		};
	}
	return {
		result: JSON.stringify({ status: result.status, ...(id ? { id } : {}), ...(result.status === "conflict" ? { currentHash: result.currentHash } : {}), reason: result.reason }, null, "\t"),
		status: "failed",
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
				description:
					"在当前主体的长期记忆中检索。返回命中的记忆 ID、标题、摘要与版本提示；需要完整内容时用 memory_read。只检索当前绑定主体与作用域，不涉及其他个体。",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "检索关键词或片段（支持中文，无需分词）" },
					},
					required: ["query"],
					additionalProperties: false,
				},
			},
		},
		async run(args) {
			const query = String(args.query ?? "");
			const hits = await store.search(query, {});
			if (hits.length === 0) {
				return { result: JSON.stringify({ hits: [] }), status: "succeeded" };
			}
			return {
				result: JSON.stringify(
					{
						hits: hits.map((h) => ({ id: h.id, title: h.title, excerpt: h.excerpt, revision: h.revision, hash: h.hash })),
					},
					null,
					"\t",
				),
				status: "succeeded",
			};
		},
	};

	const memoryRead: Tool = {
		def: {
			type: "function",
			function: {
				name: "memory_read",
				description: "读取一条长期记忆的当前完整内容（正文、来源与适用范围）。id 来自 memory_search 或 memory_write 的返回。",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "记忆 ID（memory_search 返回的 id）" },
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
			return {
				result: JSON.stringify(
					{
						id: record.id,
						title: record.title,
						body: record.body,
						type: record.type,
						basis: record.basis,
						scope: record.scope,
						sources: record.sources,
						status: record.status,
						revision: record.revision,
						hash: record.hash,
					},
					null,
					"\t",
				),
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
					"写入/修订/退休一条长期记忆。create 需 type/basis/title/body/scope/sources（或 basis=inferred + rationale）；revise/retire 需要当前 hash（从 memory_read 获得）。返回 committed 时携带新 hash——后续修订必须使用新 hash。版本冲突不覆盖：返回 conflict 与当前 hash，需重新读取后决定。",
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
												scope: { type: "object", properties: { spaceId: { type: "string" }, projectId: { type: "string" }, actorId: { type: "string" } }, additionalProperties: false },
												sources: { type: "array", items: { type: "object", properties: { sessionId: { type: "string" }, entryId: { type: "string" }, note: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
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
												scope: { type: "object", properties: { spaceId: { type: "string" }, projectId: { type: "string" }, actorId: { type: "string" } }, additionalProperties: false },
												sources: { type: "array", items: { type: "object", properties: { sessionId: { type: "string" }, entryId: { type: "string" }, note: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
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
		async run(args) {
			const operation = args.operation as MemoryChange;
			if (!operation || typeof operation !== "object" || !("op" in operation)) {
				return { result: JSON.stringify({ status: "rejected", reason: "缺少 operation" }), status: "failed" };
			}
			const id = "id" in operation ? String(operation.id) : undefined;
			try {
				const result = await store.write(operation);
				return adaptResult(id, result);
			} catch (error) {
				// writer 内部异常：不猜测结果（unknown），明确上报。
				return {
					result: JSON.stringify({ status: "unknown", ...(id ? { id } : {}), reason: `写入未确认，请用 memory_read 核实后再试：${String(error)}` }),
					status: "unknown",
				};
			}
		},
	};

	return [memorySearch, memoryRead, memoryWrite];
}
