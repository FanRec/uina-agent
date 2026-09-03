import type { Subject } from "../agent/loop.js";
import type { ModelRegistry } from "../ai/providers.js";
import type { JobRegistry } from "./jobs/registry.js";
import type { SubagentRegistry } from "./subagents/registry.js";
import type { ExtensionAPI } from "./runner.js";
import type { UIHost } from "../ui/ui-host.js";
import { ModelPicker, type ModelGroup } from "../ui/components/overlays/model-picker.js";
import { EffortSlider, DEFAULT_EFFORT_TIERS } from "../ui/components/overlays/effort-slider.js";
import { TaskDashboard } from "../ui/components/overlays/task-dashboard.js";
import { SubagentDashboard } from "../ui/components/overlays/subagent-dashboard.js";
import { SubagentDetailScene } from "../ui/components/overlays/subagent-detail-scene.js";
import { TrajectoryScene } from "../ui/components/overlays/trajectory-scene.js";
import { createJobAdapter } from "../ui/adapters/jobs.js";
import { createSubagentAdapter } from "../ui/adapters/subagents.js";

export interface BuiltinServices { subject: Subject; models: ModelRegistry; jobs: JobRegistry; subagents: SubagentRegistry; host?: UIHost; reload(): Promise<void>; shutdown(): Promise<void>; }

export function activateBuiltinCommands(services: BuiltinServices): (pi: ExtensionAPI) => void {
	return (pi) => {
		const host = () => services.host;

		pi.registerCommand({
			name: "help",
			description: "查看所有可用命令与快捷键",
			handler: () => host()?.openHelpMenu(),
		});

		pi.registerCommand({
			name: "think",
			description: "展开或折叠深度思考过程",
			handler: () => {
				host()?.transcript.toggleThinking();
				host()?.requestRender();
			},
		});

		pi.registerCommand({
			name: "clear",
			description: "清空当前屏幕转录流",
			handler: () => {
				host()?.transcript.clear();
				host()?.requestRender();
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
					const h = host();
					if (h) {
						h.toggleModal("model", (close) => {
							const picker = new ModelPicker(services.subject.getModel().name, modelGroups(services.models));
							const handle = pi.ui.showOverlay(picker);
							picker.onPick = (name) => {
								void selectModel(name);
								handle.hide();
							};
							picker.onClose = () => {
								handle.hide();
							};
							picker.onRequestRender = () => h.requestRender();
							const origHide = handle.hide.bind(handle);
							handle.hide = () => {
								close();
								origHide();
							};
							return handle;
						});
						return;
					}
					const picker = new ModelPicker(services.subject.getModel().name, modelGroups(services.models));
					const handle = pi.ui.showOverlay(picker);
					picker.onPick = (name) => { void selectModel(name); handle.hide(); };
					picker.onClose = () => handle.hide();
					return;
				}
				await selectModel(arg);
			},
		});

		const selectModel = async (arg: string): Promise<void> => {
			const provider = services.models.resolve(arg);
			await services.subject.setModel(provider);
			host()?.setModel(provider.name);
			host()?.setThinkingLevels(provider.thinkingLevels);
			host()?.setReasoningEffort(services.subject.getThinkingLevel());
			host()?.setUsage(services.subject.getUsedTokens(), services.subject.getContextWindow());
			pi.ui.notify(`已切换至模型: ${provider.name}`);
		};

		pi.registerCommand({
			name: "effort",
			description: "设置或调整模型思考强度",
			hasArgs: true,
			argumentHint: "<level>",
			handler: (arg) => {
				if (!arg) {
					const declaredLevels = services.subject.getModel().thinkingLevels;
					if (!declaredLevels?.length) {
						pi.ui.notify("当前 Provider 未提供 thinking 能力元数据；Uina 不会猜测可用档位。", "warning");
						return;
					}
					const h = host();
					if (h) {
						h.toggleModal("effort", (close) => {
							const slider = new EffortSlider(
								services.subject.getThinkingLevel(),
								DEFAULT_EFFORT_TIERS.filter((tier) => declaredLevels.includes(tier.id)),
							);
							const handle = pi.ui.showOverlay(slider);
							slider.onChange = (level) => {
								services.subject.setThinkingLevel(level);
								h.setReasoningEffort(level);
							};
							slider.onClose = () => {
								handle.hide();
							};
							slider.onRequestRender = () => h.requestRender();
							const origHide = handle.hide.bind(handle);
							handle.hide = () => {
								close();
								origHide();
							};
							return handle;
						});
						return;
					}
					const slider = new EffortSlider(
						services.subject.getThinkingLevel(),
						DEFAULT_EFFORT_TIERS.filter((tier) => declaredLevels.includes(tier.id)),
					);
					const handle = pi.ui.showOverlay(slider);
					slider.onChange = (level) => {
						services.subject.setThinkingLevel(level);
						host()?.setReasoningEffort(level);
					};
					slider.onClose = () => handle.hide();
					return;
				}
				const level = arg as import("../core/types.js").ThinkingLevel;
				const levels = services.subject.getModel().thinkingLevels;
				if (!levels?.includes(level)) {
					throw new Error(levels ? `当前 Provider 不支持思考等级: ${arg}` : "当前 Provider 未声明 thinking 能力");
				}
				services.subject.setThinkingLevel(level);
				host()?.setReasoningEffort(level);
			},
		});

		pi.registerCommand({
			name: "compact",
			description: "压缩会话历史释放上下文空间",
			hasArgs: true,
			argumentHint: "[instruction]",
			handler: (arg) => services.subject.compact(arg || undefined),
		});

		pi.registerCommand({
			name: "tasks",
			description: "后台任务与进程看板 (Alt+J)",
			handler: () => showTasks(pi, services.jobs, host()),
		});

		pi.registerCommand({
			name: "subagents",
			description: "多子智能体并行看板 (Alt+A)",
			handler: () => showSubagents(pi, services.subagents, host()),
		});

		pi.registerCommand({
			name: "trajectory",
			description: "全屏审计轨迹时序看板 (Alt+T)",
			handler: () => {
				const h = host();
				if (h) {
					h.toggleModal("trajectory", (close) => {
						const scene = new TrajectoryScene(h.trajectoryProjection);
						const handle = pi.ui.showOverlay(scene);
						scene.onClose = () => {
							handle.hide();
						};
						const origHide = handle.hide.bind(handle);
						handle.hide = () => {
							close();
							origHide();
						};
						return handle;
					});
				}
			},
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

function showTasks(pi: ExtensionAPI, jobs: JobRegistry, host?: UIHost): void {
	if (host) {
		host.toggleModal("tasks", (close) => {
			const view = new TaskDashboard(createJobAdapter(jobs));
			const handle = pi.ui.showOverlay(view);
			view.onClose = () => {
				handle.hide();
			};
			const origHide = handle.hide.bind(handle);
			handle.hide = () => {
				close();
				origHide();
			};
			return handle;
		});
	} else {
		const view = new TaskDashboard(createJobAdapter(jobs));
		const handle = pi.ui.showOverlay(view);
		view.onClose = () => handle.hide();
	}
}

function showSubagents(pi: ExtensionAPI, subagents: SubagentRegistry, host?: UIHost): void {
	if (host) {
		host.toggleModal("subagents", (close) => {
			const view = new SubagentDashboard(createSubagentAdapter(subagents));
			const handle = pi.ui.showOverlay(view);
			view.onClose = () => {
				handle.hide();
			};
			view.onDrilldown = (agent) => {
				handle.hide();
				const detail = new SubagentDetailScene(agent, createSubagentAdapter(subagents));
				const next = pi.ui.showOverlay(detail);
				const origNextHide = next.hide.bind(next);
				next.hide = () => {
					close();
					origNextHide();
				};
				detail.onClose = () => next.hide();
			};
			const origHide = handle.hide.bind(handle);
			handle.hide = () => {
				close();
				origHide();
			};
			return handle;
		});
	} else {
		const view = new SubagentDashboard(createSubagentAdapter(subagents));
		const handle = pi.ui.showOverlay(view);
		view.onClose = () => handle.hide();
		view.onDrilldown = (agent) => {
			handle.hide();
			const detail = new SubagentDetailScene(agent, createSubagentAdapter(subagents));
			const next = pi.ui.showOverlay(detail);
			detail.onClose = () => next.hide();
		};
	}
}

function modelGroups(models: ModelRegistry): ModelGroup[] {
	return models.choices().map((choice) => ({
		id: choice.id,
		name: choice.id,
		description: "已配置或已注册 Provider",
		models: [{ id: choice.id, name: choice.name, description: choice.id, provider: choice.id }],
	}));
}
