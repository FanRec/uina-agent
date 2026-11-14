import type { Tool } from "../../tools/broker.js";
import type { ExtensionAPI } from "../runner.js";

/**
 * 原生 runtime_reload 工具（S2/S3）：重新加载本地资源或项目扩展，使文件修改生效。
 *
 * 注册在内置 runtime-tools——不属于可被 extensions Reload 卸载的项目扩展。名称使用
 * 跨 Provider 兼容的下划线；唯一必填参数 scope，不加 force/reason/target/dryRun 或
 * 目标文件参数；工具不编辑文件。executionMode=sequential：同一批次内文件修改与
 * Reload 不并行执行，模型仍需按调用次序先编辑、后 Reload。
 *
 * 结果合同（§5.2）：保留 ToolResult 五态；applied/scheduled 是业务阶段（details.phase），
 * 不是第六种工具状态。resources 等待发布完成后返回（不终止推理）；extensions 只
 * 受理排定即返回 scheduled + reloadId + continuation=stop——Tool Result 先正常配对
 * 写入 Canonical History，本回合在批次结算后结束，实际换代在回合安全点执行。
 */
export function createRuntimeReloadTool(pi: ExtensionAPI): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "runtime_reload",
				description: "重新加载本地资源或项目扩展，使文件修改生效。不会重启 Uina 或清空会话。",
				parameters: {
					type: "object",
					properties: {
						scope: {
							type: "string",
							enum: ["resources", "extensions"],
							description:
								"resources：刷新 System、文件式 Guidance 和 Skills，下次推理生效。extensions：本轮结束后重载项目扩展及资源，可能中断连接。",
						},
					},
					required: ["scope"],
					additionalProperties: false,
				},
			},
		},
		executionMode: "sequential",
		run: async (args: Record<string, unknown>) => {
			const scope = args.scope;
			if (scope === "resources") {
				// 等待发布完成：applied 之后正常继续本轮模型调用，下一次请求必然采用新版本。
				if (!pi.reloadResources) throw new Error("宿主未提供资源刷新入口（runtime_reload resources）");
				const outcome = await pi.reloadResources();
				if (!outcome.ok) {
					return {
						result: `资源刷新失败，现行资源保持不变：${outcome.error ?? "未知原因"}`,
						status: "failed" as const,
						details: { phase: "unchanged", error: outcome.error },
					};
				}
				const summary = outcome.summary ? ` ${outcome.summary}` : "";
				const versionNote = outcome.unchanged
					? "内容无变化，版本未推进"
					: `已发布版本 ${shortRevision(outcome.revision)}`;
				return {
					result: `资源已刷新（${versionNote}）；下一次模型请求将使用${outcome.unchanged ? "当前" : "新"}版本。${summary}`,
					status: "succeeded" as const,
					details: { phase: "applied", revision: outcome.revision, ...(outcome.unchanged ? { unchanged: true } : {}) },
				};
			}
			if (scope === "extensions") {
				// 只受理排定，不等待换代完成（等待自己结束会死锁）。continuation=stop：
				// Tool Result 正常配对落盘后结束当前决策回合，换代在回合安全点执行。
				if (!pi.scheduleExtensionsReload) throw new Error("宿主未提供扩展换代协调入口（runtime_reload extensions）");
				const { reloadId } = pi.scheduleExtensionsReload();
				return {
					result:
						`项目扩展换代已排定（reloadId: ${reloadId}）。该操作尚未生效：` +
						"当前批次的所有工具结果会先正常写入会话，本回合随即结束；待所有活动结算后，" +
						"运行时会重载项目扩展并刷新资源，最终结果会以运行时通知送达。",
					status: "succeeded" as const,
					details: { phase: "scheduled", reloadId },
					continuation: "stop" as const,
				};
			}
			return {
				result: `runtime_reload 的 scope 必须是 "resources" 或 "extensions"，收到: ${JSON.stringify(scope ?? null)}`,
				status: "failed" as const,
				details: { phase: "unchanged" },
			};
		},
	};
}

function shortRevision(revision: string | undefined): string {
	return revision ? revision.slice(0, 12) : "未知";
}
