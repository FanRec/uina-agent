import type { Subject } from "../agent/loop.js";
import type { ModelRegistry } from "../ai/providers.js";
import type { JobRegistry } from "./jobs/registry.js";
import type { SubagentRegistry } from "./subagents/registry.js";
import type { ExtensionAPI } from "./runner.js";
import type { ThinkingLevel } from "../core/types.js";

export interface BuiltinUIModelGroup {
	id: string;
	name: string;
	description: string;
	models: Array<{ id: string; name: string; description: string; provider: string }>;
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
	setModel?(name: string): void;
	setThinkingLevels?(levels?: readonly ThinkingLevel[]): void;
	setReasoningEffort?(level?: ThinkingLevel): void;
	setUsage?(used: number, window?: number): void;
	getGutterMode?(): "scrollbar" | "timeline";
	setGutterMode?(mode: "scrollbar" | "timeline"): void;
	getScrollbarThumbStyle?(): "slim" | "block" | "wide";
	setScrollbarThumbStyle?(style: "slim" | "block" | "wide"): void;
	addCompaction?(record: {
		summary: string;
		turnsCount: number;
		tokensSaved: number;
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
						ui.openModelPicker(services.subject.getModel().name, modelGroups(services.models), (name) => selectModel(name));
					}
					return;
				}
				await selectModel(arg);
			},
		});

		const selectModel = async (arg: string): Promise<void> => {
			const provider = services.models.resolve(arg);
			await services.subject.setModel(provider);
			ui?.setModel?.(provider.name);
			ui?.setThinkingLevels?.(provider.thinkingLevels);
			ui?.setReasoningEffort?.(services.subject.getThinkingLevel());
			ui?.setUsage?.(services.subject.getUsedTokens(), services.subject.getContextWindow());
			pi.ui.notify(`已切换至模型: ${provider.name}`);
		};

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
			ui?.setReasoningEffort?.(e.level);
			pi.ui.notify(`思考等级: ${e.level}`, "info", 2000);
		});

		pi.registerCommand({
			name: "compact",
			description: "压缩会话历史释放上下文空间",
			hasArgs: true,
			argumentHint: "[instruction]",
			handler: (arg) => services.subject.compact(arg || undefined),
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
					tokensSaved: e.tokensBefore,
					collapsed: true,
				});
			} else {
				process.stdout.write(`\n[会话压缩] ${e.summary}\n`);
			}
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
	return models.choices().map((choice) => ({
		id: choice.id,
		name: choice.name,
		description: choice.id,
		models: [{ id: choice.id, name: choice.name, description: choice.id, provider: choice.id }],
	}));
}
