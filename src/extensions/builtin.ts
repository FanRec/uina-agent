import type { Subject } from "../agent/loop.js";
import type { ModelRegistry } from "../ai/providers.js";
import type { JobRegistry } from "./jobs/registry.js";
import type { SubagentRegistry } from "./subagents/registry.js";
import type { ExtensionAPI } from "./runner.js";
import type { ContextSegments, ThinkingLevel } from "../core/types.js";
import { listAllSessionNodes } from "../session/navigation.js";

export interface BuiltinUIModelGroup {
	id: string;
	name: string;
	description: string;
	models: Array<{ id: string; name: string; description: string; provider: string }>;
}

/**
 * 用量表快照：一次 setUsage 的全部信息。单对象参数 —— 同形异义的位置参数
 * 曾跨层漂移（桥接层第三参是 segments、宿主层是 actual，对象落进布尔位），
 * 对象字段名自描述，这类漂移无从发生。
 */
export interface UsageSnapshot {
	used: number;
	contextWindow?: number;
	/** false = 估算值（保留尾巴 / 刚切口径），true = 服务端真实总量。 */
	actual?: boolean;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	segments?: ContextSegments;
}
export interface BuiltinUI {
	openHelpMenu(): void;
	toggleThinking(): void;
	clear(): void;
	openModelPicker(currentModel: string, groups: BuiltinUIModelGroup[], onPick: (name: string) => Promise<void> | void): void;
	openEffortSlider(currentLevel: ThinkingLevel, declaredLevels: ThinkingLevel[], onChange: (level: ThinkingLevel) => void): void;
	openTasks(): void;
	openSubagents(): void;
	openTrajectory(): void;
	openHistory?(): void;
	setModel?(name: string): void;
	setThinkingLevels?(levels?: readonly ThinkingLevel[]): void;
	setReasoningEffort?(level?: ThinkingLevel): void;
	setUsage?(snapshot: UsageSnapshot): void;
	getGutterMode?(): "scrollbar" | "timeline";
	setGutterMode?(mode: "scrollbar" | "timeline"): void;
	getScrollbarThumbStyle?(): "slim" | "block" | "wide";
	setScrollbarThumbStyle?(style: "slim" | "block" | "wide"): void;
	addCompaction?(record: {
		summary: string;
		turnsCount: number;
		tokensBefore: number;
		collapsed: boolean;
	}): void;
}

export interface BuiltinServices {
	subject: Subject;
	models: ModelRegistry;
	jobs: JobRegistry;
	subagents: SubagentRegistry;
	ui?: BuiltinUI;
	reload(): Promise<void>;
	shutdown(): Promise<void>;
}

export function activateBuiltinCommands(services: BuiltinServices): (pi: ExtensionAPI) => void {
	return (pi) => {
		const ui = services.ui;

		pi.registerCommand({
			name: "help",
			description: "查看所有可用命令与快捷键",
			handler: () => ui?.openHelpMenu(),
		});

		pi.registerCommand({
			name: "think",
			description: "展开或折叠深度思考过程",
			handler: () => ui?.toggleThinking(),
		});

		pi.registerCommand({
			name: "clear",
			description: "清空当前屏幕转录流",
			handler: () => ui?.clear(),
		});

		pi.registerCommand({
			name: "gutter",
			description: "切换右侧导航轨模式与滑块样式 (scrollbar|timeline [slim|block|wide])",
			hasArgs: true,
			argumentHint: "[scrollbar|timeline] [slim|block|wide]",
			handler: (arg) => {
				if (!ui) return;
				const parts = arg?.trim().toLowerCase().split(/\s+/) ?? [];
				const first = parts[0];
				const second = parts[1];

				if (first === "slim" || first === "block" || first === "wide") {
					ui.setGutterMode?.("scrollbar");
					ui.setScrollbarThumbStyle?.(first);
					pi.ui.notify(`已切换滚动条滑块样式为: ${first === "slim" ? "纤细优雅 ( ▐)" : first === "block" ? "单列方块 ( █)" : "双列宽方块 (██)"}`);
					return;
				}

				if (first === "scrollbar" || first === "timeline") {
					ui.setGutterMode?.(first);
					if (first === "scrollbar" && (second === "slim" || second === "block" || second === "wide")) {
						ui.setScrollbarThumbStyle?.(second);
					}
					pi.ui.notify(`已切换右侧导航轨为: ${first === "scrollbar" ? "视口比例滚动条 (Scrollbar)" : "时间线轮次轨 (Timeline)"}${second ? ` [${second}]` : ""}`);
				} else {
					const current = ui.getGutterMode?.() ?? "scrollbar";
					const next = current === "scrollbar" ? "timeline" : "scrollbar";
					ui.setGutterMode?.(next);
					pi.ui.notify(`已切换右侧导航轨为: ${next === "scrollbar" ? "视口比例滚动条 (Scrollbar)" : "时间线轮次轨 (Timeline)"}`);
				}
			},
		});

		pi.registerCommand({
			name: "session",
			description: "查看会话用量与上下文信息",
			handler: () => {
				const model = services.subject.getModel();
				const used = services.subject.getUsedTokens();
				const window = services.subject.getContextWindow();
				const context = window === undefined
					? `约 ${used}/上限未知`
					: `约 ${used}/${window} (${Math.round((used / window) * 100)}%)`;
				pi.ui.notify(`会话信息: 模型=${model.name} · Token=${context} · 思考=${services.subject.getThinkingLevel()}`);
			},
		});

		pi.registerCommand({
			name: "model",
			description: "切换模型或打开模型选择面板",
			hasArgs: true,
			argumentHint: "<provider>",
			handler: async (arg) => {
				if (!arg) {
					if (ui) {
						// 传复合键 providerId/modelId：同 id 模型跨 provider 时选择器才能唯一标定当前项；
					// onPick 回传复合键，resolve() 精确命中对应 provider（避免假切换到首个同名模型）。
					const current = services.subject.getModel();
					ui.openModelPicker(`${current.providerId}/${current.id}`, modelGroups(services.models), (name) => selectModel(name));
					}
					return;
				}
				await selectModel(arg);
			},
		});

		/** 用量表刷新：真值已作废（压缩 / 切模型），先按估算显示并标注非真实。 */
		const refreshUsageMeter = (): void => {
			ui?.setUsage?.({
				used: services.subject.getUsedTokens(),
				contextWindow: services.subject.getContextWindow(),
				actual: false,
				segments: services.subject.getContextSegments(),
			});
		};

		const selectModel = async (arg: string): Promise<void> => {
			await pi.models.select(arg);
			const model = pi.models.current();
			ui?.setModel?.(model.name);
			ui?.setThinkingLevels?.(model.thinkingLevels);
			ui?.setReasoningEffort?.(model.thinkingLevels?.length ? services.subject.getThinkingLevel() : undefined);
			refreshUsageMeter();
			// 诚实化：回合内模型是快照，工作中切换要到下一个请求批次才生效
			pi.ui.notify(services.subject.isBusy?.() ? `已切换至模型: ${model.name}（当前回合结束后生效）` : `已切换至模型: ${model.name}`);
		};

		pi.on("model_select", () => {
			const model = pi.models.current();
			ui?.setModel?.(model.name);
			ui?.setThinkingLevels?.(model.thinkingLevels);
			ui?.setReasoningEffort?.(model.thinkingLevels?.length ? services.subject.getThinkingLevel() : undefined);
			refreshUsageMeter();
		});

		pi.registerCommand({
			name: "effort",
			description: "设置或调整模型思考强度",
			hasArgs: true,
			argumentHint: "<level>",
			handler: (arg) => {
				const declaredLevels = services.subject.getModel().thinkingLevels;
				if (!arg) {
					if (!declaredLevels?.length) {
						pi.ui.notify("当前 Provider 未提供 thinking 能力元数据；Uina 不会猜测可用档位。", "warning");
						return;
					}
					if (ui) {
						ui.openEffortSlider(services.subject.getThinkingLevel(), declaredLevels as ThinkingLevel[], (level) => {
							services.subject.setThinkingLevel(level);
						});
					}
					return;
				}
				const level = arg as ThinkingLevel;
				if (!declaredLevels?.includes(level)) {
					throw new Error(declaredLevels ? `当前 Provider 不支持思考等级: ${arg}` : "当前 Provider 未声明 thinking 能力");
				}
				services.subject.setThinkingLevel(level);
			},
		});

		pi.on("thinking_level_select", (e) => {
			ui?.setReasoningEffort?.(services.subject.getModel().thinkingLevels?.includes(e.level) ? e.level : undefined);
			pi.ui.notify(services.subject.isBusy?.() ? `思考等级: ${e.level}（当前回合结束后生效）` : `思考等级: ${e.level}`, "info", 2000);
		});

		pi.registerCommand({
			name: "compact",
			description: "压缩会话历史释放上下文空间",
			hasArgs: true,
			argumentHint: "[instruction]",
			handler: (arg) => pi.compact(arg || undefined),
		});

		pi.on("session_before_compact", () => {
			pi.ui.notify("正在压缩会话…", "info", 0);
		});

		pi.on("session_compact", (e) => {
			pi.ui.notify("会话已压缩", "info", 2500);
			if (ui?.addCompaction) {
				ui.addCompaction({
					summary: e.summary,
					turnsCount: e.retainedTailCount,
					tokensBefore: e.tokensBefore,
					collapsed: true,
				});
			} else {
				process.stdout.write(`\n[会话压缩] ${e.summary}\n`);
			}
			// 压缩换掉了历史：用量表立即按估算刷新，并标注为非真实（保留尾巴是字符估算）。
			refreshUsageMeter();
		});

		pi.on("session_compact_failed", () => {
			pi.ui.notify("会话压缩失败", "warning", 3000);
		});

		pi.registerCommand({
			name: "tasks",
			description: "后台任务与进程看板 (Alt+J)",
			handler: () => ui?.openTasks(),
		});

		pi.registerCommand({
			name: "subagents",
			description: "多子智能体并行看板 (Alt+A)",
			handler: () => ui?.openSubagents(),
		});

		pi.registerCommand({
			name: "trajectory",
			description: "全屏审计轨迹时序看板 (Alt+T)",
			handler: () => ui?.openTrajectory(),
		});

		const openHistory = (): void => {
			if (ui?.openHistory) {
				ui.openHistory();
				return;
			}
			const nodes = listAllSessionNodes(services.subject.session, { scope: "all" });
			const formatted = nodes.map((n) => `[${n.active ? "主线" : "只读"} #${n.seq} ${n.kind}] ${n.id.slice(0, 8)} ${n.preview}`).join("\n");
			pi.ui.notify(formatted ? `会话历史节点:\n${formatted}` : "暂无历史节点", "info", 8000);
		};

		pi.registerCommand({
			name: "history",
			description: "会话历史节点与已回溯分支看板 (Alt+H)",
			handler: openHistory,
		});

		pi.registerCommand({
			name: "branches",
			description: "会话历史分支检视 (同 /history)",
			handler: openHistory,
		});

		pi.registerCommand({
			name: "reload",
			description: "重载项目与本地扩展",
			handler: () => services.reload(),
		});

		pi.registerCommand({
			name: "quit",
			description: "退出 Uina 控制台",
			handler: () => services.shutdown(),
		});
	};
}

function modelGroups(models: ModelRegistry): BuiltinUIModelGroup[] {
	return models.groups();
}
