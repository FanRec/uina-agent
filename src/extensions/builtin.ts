import type { ExtensionAPI } from "./runner.js";
import type { ThinkingLevel } from "../core/types.js";
import { listAllSessionNodes } from "../session/navigation.js";
export { resolveGutterAction } from "../ui/core/gutter.js";

/** 右侧导航轨模式与滑块样式（与 ui-contract 的成员签名一致）。 */

/**
 * 官方内置命令 = preinstalled capability：与项目扩展完全相同的 API 面（pi.*），
 * 不持有特权 Subject 句柄，也没有平行的 BuiltinServices/BuiltinUI 装配束。
 * 消费者富 UI 能力经 pi.ui 的可选成员提供，
 * 不支持的消费者（stdio/print）自然降级为无操作。
 */
export function activateBuiltinCommands(pi: ExtensionAPI): void {
	const ui = pi.ui;

	pi.registerCommand({
		name: "help",
		description: "查看所有可用命令与快捷键",
		handler: () => { ui.openFeature?.("help"); },
	});

	pi.registerCommand({
		name: "think",
		description: "展开或折叠深度思考过程",
		handler: () => { ui.openFeature?.("toggle-thinking"); },
	});

	pi.registerCommand({
		name: "clear",
		description: "清空当前屏幕转录流",
		handler: () => { ui.openFeature?.("clear-transcript"); },
	});

	pi.registerCommand({
		name: "gutter",
		description: "切换右侧导航轨模式与滑块样式 (scrollbar|timeline [slim|block|wide])",
		hasArgs: true,
		argumentHint: "[scrollbar|timeline] [slim|block|wide]",
		handler: (arg) => { ui.openFeature?.("gutter", { arg }); },
	});

	pi.registerCommand({
		name: "session",
		description: "查看会话用量与上下文信息",
		handler: async () => {
			const model = pi.models.current();
			const snapshot = await pi.context();
			const used = snapshot.inputTokens;
			const window = snapshot.contextWindow;
			const context = used === undefined ? "未知" : window === undefined
				? `约 ${used}/上限未知`
				: `约 ${used}/${window} (${Math.round((used / window) * 100)}%)`;
			pi.ui.notify(`会话信息: 模型=${model.name} · Token=${context} · 思考=${pi.models.thinkingLevel()}`);
		},
	});

	pi.registerCommand({
		name: "model",
		description: "切换模型或打开模型选择面板",
		hasArgs: true,
		argumentHint: "<provider>",
		handler: async (arg) => {
			if (!arg) {
				// 传复合键 providerId/modelId：同 id 模型跨 provider 时选择器才能唯一标定当前项；
				// onPick 回传复合键，resolve() 精确命中对应 provider（避免假切换到首个同名模型）。
				const current = pi.models.current();
				ui.openFeature?.("model-picker", { currentModel: `${current.providerId}/${current.id}`, groups: pi.models.groups(), onPick: (name: string) => selectModel(name) });
				return;
			}
			await selectModel(arg);
		},
	});

	const selectModel = async (arg: string): Promise<void> => {
		await pi.models.select(arg);
		const model = pi.models.current();
		// 诚实化：回合内模型是快照，工作中切换要到下一个请求批次才生效
		pi.ui.notify(pi.isBusy() ? `已切换至模型: ${model.name}（当前回合结束后生效）` : `已切换至模型: ${model.name}`);
	};


	pi.registerCommand({
		name: "effort",
		description: "设置或调整模型思考强度",
		hasArgs: true,
		argumentHint: "<level>",
		handler: (arg) => {
			const declaredLevels = pi.models.current().thinkingLevels;
			if (!arg) {
				if (!declaredLevels?.length) {
					pi.ui.notify("当前 Provider 未提供 thinking 能力元数据；Uina 不会猜测可用档位。", "warning");
					return;
				}
				ui.openFeature?.("effort-slider", { currentLevel: pi.models.thinkingLevel(), tiers: declaredLevels as ThinkingLevel[], onChange: (level: ThinkingLevel) => pi.models.setThinkingLevel(level) });
				return;
			}
			const level = arg as ThinkingLevel;
			if (!declaredLevels?.includes(level)) {
				throw new Error(declaredLevels ? `当前 Provider 不支持思考等级: ${arg}` : "当前 Provider 未声明 thinking 能力");
			}
			pi.models.setThinkingLevel(level);
		},
	});

	pi.on("thinking_level_select", (e) => {
		pi.ui.notify(pi.isBusy() ? `思考等级: ${e.level}（当前回合结束后生效）` : `思考等级: ${e.level}`, "info", 2000);
	});

	// /compact 命令归 official compaction capability 端到端拥有；压缩进度由
	// 三个 session_compact_* 事实事件表达。

	pi.on("session_compact_start", () => {
		pi.ui.setWorking("compaction", "正在压缩上下文");
	});

	pi.on("session_compact_progress", (e) => {
		pi.ui.setWorking("compaction", e.detail ? `正在压缩上下文：${e.detail}` : "正在压缩上下文");
	});

	pi.on("session_compact", (e) => {
		pi.ui.setWorking("compaction", undefined);
		const message = e.status === "completed" ? "会话已压缩" : e.status === "noop" ? "当前无需压缩" : `会话压缩${e.status === "cancelled" ? "已取消" : "失败"}${e.error ? `：${e.error}` : ""}`;
		pi.ui.notify(message, e.status === "completed" || e.status === "noop" ? "info" : "warning", e.status === "completed" || e.status === "noop" ? 2500 : 3000);
		// 永久转录只记录已提交的压缩事实；失败/取消/noop 是瞬态结果，
		// 只通知不堆卡片，避免重试把错误状态污染会话阅读流。
	});

	pi.registerCommand({
		name: "tasks",
		description: "后台任务与进程看板 (Alt+J)",
		handler: () => { ui.openFeature?.("tasks"); },
	});

	pi.registerCommand({
		name: "subagents",
		description: "多子智能体并行看板 (Alt+A)",
		handler: () => { ui.openFeature?.("subagents"); },
	});

	pi.registerCommand({
		name: "trajectory",
		description: "全屏审计轨迹时序看板 (Alt+T)",
		handler: () => { ui.openFeature?.("trajectory"); },
	});

	const openHistory = (): void => {
		if (ui.openFeature?.("history")) return;
		const nodes = listAllSessionNodes(pi.session, { scope: "all" });
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
		handler: () => pi.reload(),
	});

	pi.registerCommand({
		name: "quit",
		description: "退出 Uina 控制台",
		handler: () => pi.shutdown(),
	});
}
