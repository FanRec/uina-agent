import type { Tool } from "../../tools/broker.js";
import type { ActionContext, AppDef, AppRuntime, OperationIdentity, SurfaceTier } from "./types.js";

/** 框架为所有 App 自动追加的通用内置动作 */
export const BUILTIN_ACTIONS = ["close", "ambient", "help", "status"] as const;
export type BuiltinAction = (typeof BUILTIN_ACTIONS)[number];

export interface FacadeToolOptions {
	/** 获取应用运行时状态的访问器 */
	getRuntime: () => AppRuntime;
	/** 切换视口档位回调 */
	setTier: (tier: SurfaceTier) => void;
}

/**
 * 为给定的 App 定义生成一个门面工具（Facade Tool）
 * 严格恪守：
 * 1. 视觉压缩：大模型仅看到一个门面工具
 * 2. 语义保留：派发时解析出强类型 OperationIdentity (app:name/action)，注入 details
 * 3. Fail-Fast：未知 action 诚实报错并提示可用列表，绝不擅自副作用改变视口
 */
export function createFacadeTool(def: AppDef, options: FacadeToolOptions): Tool {
	const allActionNames = [...Object.keys(def.actions), ...BUILTIN_ACTIONS];
	const actionSummaries: string[] = [];
	for (const [name, actionDef] of Object.entries(def.actions)) {
		let paramDesc = "";
		if (actionDef.parameters && typeof actionDef.parameters === "object") {
			const props = (actionDef.parameters.properties ?? {}) as Record<string, { type?: string; description?: string }>;
			const propKeys = Object.keys(props);
			if (propKeys.length > 0) {
				const required = Array.isArray(actionDef.parameters.required) ? actionDef.parameters.required : [];
				paramDesc = `，参数: { ${propKeys.map((k) => `${k}${required.includes(k) ? "" : "?"}: ${props[k]?.type ?? "any"}`).join(", ")} }`;
			}
		}
		actionSummaries.push(`- "${name}": ${actionDef.description}${paramDesc}`);
	}
	actionSummaries.push('- "close": 收起面板到后台 (hidden)');
	actionSummaries.push('- "ambient": 切换为环境感知模式 (ambient)');
	actionSummaries.push('- "help": 查看帮助说明');

	const parametersSchema: Record<string, unknown> = {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: `子操作名称。留空时打开/刷新操作面板。\n可用操作清单:\n${actionSummaries.join("\n")}`,
			},
			params: {
				type: "object",
				description: "子操作的具体参数键值对（根据上述 action 说明传入）",
			},
		},
	};

	return {
		def: {
			type: "function",
			function: {
				name: def.name,
				description: `${def.description} (空参调用可唤起操作面板)`,
				parameters: parametersSchema,
			},
		},
		run: async (rawArgs: Record<string, unknown>, signal?: AbortSignal) => {
			const actionName = typeof rawArgs.action === "string" ? rawArgs.action.trim() : undefined;
			const params = (typeof rawArgs.params === "object" && rawArgs.params !== null ? rawArgs.params : {}) as Record<
				string,
				unknown
			>;

			// 1. 空参调用分支 -> 打开/展开视口
			if (!actionName) {
				options.setTier("expanded");
				const runtime = options.getRuntime();
				runtime.lastActiveTurn = Date.now();
				return {
					result: `《${def.name}》界面已展开。当前状态与可用指令已加载至视口底部。`,
					status: "succeeded",
					details: {
						operationIdentity: `app:${def.name}/open` as OperationIdentity,
						appName: def.name,
						action: "open",
					},
				};
			}

			// 2. 框架通用内置动作分支
			if (actionName === "close") {
				const runtime = options.getRuntime();
				const wasHidden = runtime.surfaceTier === "hidden";
				options.setTier("hidden");
				return {
					result: wasHidden
						? `《${def.name}》界面此前已处于关闭状态 (hidden)，无需重复关闭。`
						: `《${def.name}》界面已关闭。`,
					status: "succeeded",
					details: {
						operationIdentity: `app:${def.name}/close` as OperationIdentity,
						appName: def.name,
						action: "close",
					},
				};
			}

			if (actionName === "ambient") {
				const runtime = options.getRuntime();
				const wasAmbient = runtime.surfaceTier === "ambient";
				options.setTier("ambient");
				return {
					result: wasAmbient
						? `《${def.name}》此前已处于后台轻量感知模式 (ambient)。`
						: `《${def.name}》已切换至后台轻量感知模式。`,
					status: "succeeded",
					details: {
						operationIdentity: `app:${def.name}/ambient` as OperationIdentity,
						appName: def.name,
						action: "ambient",
					},
				};
			}

			if (actionName === "help") {
				const helpLines = [
					`=== 《${def.name}》操作指令指南 ===`,
					...Object.entries(def.actions).map(([act, actDef]) => `- ${act}: ${actDef.description}`),
					"- close: 关闭本应用视口界面",
					"- ambient: 收起详细界面，转入后台轻量感知模式",
					"- help: 查看本帮助指南",
				];
				return {
					result: helpLines.join("\n"),
					status: "succeeded",
					details: {
						operationIdentity: `app:${def.name}/help` as OperationIdentity,
						appName: def.name,
						action: "help",
					},
				};
			}

			if (actionName === "status" && !def.actions["status"]) {
				const runtime = options.getRuntime();
				const stateDesc = def.render
					? await def.render(runtime.surfaceTier === "hidden" ? "expanded" : runtime.surfaceTier)
					: `当前视口档位: ${runtime.surfaceTier}`;
				return {
					result: `《${def.name}》当前状态:\n${stateDesc}`,
					status: "succeeded",
					details: {
						operationIdentity: `app:${def.name}/status` as OperationIdentity,
						appName: def.name,
						action: "status",
					},
				};
			}

			// 3. 具体业务动作分支
			const targetAction = def.actions[actionName];
			if (!targetAction) {
				// 未知 action -> Fail Fast，诚实报错，绝不擅自副作用改变视口
				return {
					result: `【${def.name} 错误】未知操作: "${actionName}"。\n可用操作列表: ${allActionNames.join(", ")}。\n可使用空参调用打开操作指南。`,
					status: "failed",
					details: {
						operationIdentity: `app:${def.name}/${actionName}` as OperationIdentity,
						appName: def.name,
						action: actionName,
						error: "unknown_action",
					},
				};
			}

			// 4. 参数校验（如果定义了 validate）
			if (targetAction.validate) {
				const validation = targetAction.validate(params);
				if (!validation.valid) {
					return {
						result: `【${def.name} 参数错误】操作 "${actionName}" 的参数无效: ${validation.error ?? "格式不匹配"}`,
						status: "failed",
						details: {
							operationIdentity: `app:${def.name}/${actionName}` as OperationIdentity,
							appName: def.name,
							action: actionName,
							error: "invalid_parameters",
						},
					};
				}
			}

			// 5. 执行动作
			const operationIdentity: OperationIdentity = `app:${def.name}/${actionName}`;
			const actionContext: ActionContext = {
				setTier: options.setTier,
				getTier: () => options.getRuntime().surfaceTier,
				operationIdentity,
			};

			const runtime = options.getRuntime();
			runtime.lastActiveTurn = Date.now();

			try {
				if (signal?.aborted) {
					return {
						result: `操作 "${actionName}" 已被取消。`,
						status: "cancelled",
						details: { operationIdentity, appName: def.name, action: actionName },
					};
				}

				const output = await targetAction.run(params, actionContext);

				if (typeof output === "string") {
					return {
						result: output,
						status: "succeeded",
						details: { operationIdentity, appName: def.name, action: actionName },
					};
				}

				return {
					...output,
					details: {
						...(typeof output.details === "object" && output.details !== null ? output.details : {}),
						operationIdentity,
						appName: def.name,
						action: actionName,
					},
				};
			} catch (error) {
				return {
					result: `【${def.name} 执行失败】${error instanceof Error ? error.message : String(error)}`,
					status: "failed",
					details: {
						operationIdentity,
						appName: def.name,
						action: actionName,
						error: error instanceof Error ? error.stack : String(error),
					},
				};
			}
		},
	};
}
