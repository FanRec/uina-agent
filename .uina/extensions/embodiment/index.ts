import { CUE_DISPATCH_SHARED, type CueDispatcher } from "./playback-cues.js";
import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import { WORLD_EXPOSED_SHARED_NAME, type WorldExposedRegistry } from "../../../src/extensions/world-framework/types.js";
import { BodyRouter } from "./body-router.js";
import { createBodyTool } from "./tools.js";
import { BODY_ENDPOINT_EXPOSED_PREFIX, type BodyEndpoint } from "./types.js";

export * from "./types.js";
export * from "./body-router.js";
export * from "./tools.js";

/** 结构校验：共享表里的值必须真的满足 BodyEndpoint 行为契约，否则拒绝并报错。 */
function isBodyEndpoint(value: unknown): value is BodyEndpoint {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.bodyId === "string" &&
		typeof candidate.bodyType === "string" &&
		typeof candidate.affordance === "function" &&
		typeof candidate.state === "function" &&
		typeof candidate.emitCue === "function" &&
		typeof candidate.safeStop === "function" && typeof candidate.resume === "function"
	);
}

/**
 * 激活具身扩展 (Embodiment Extension)
 *
 * 输出表达体系：本扩展注册 <cue> Marker 语法，只消费 Output Interpretation 的
 * marker 语义事件（Speech 外的线索按流语义顺序执行一次；Speech 内的线索由
 * Speech 按播放边界驱动），不再自行解析模型原文，也没有 TUI 剥标签转换器——
 * 展示文字由 Presentation 从语义事件生成，标签不会出现。
 */
export function activateEmbodimentExtension(pi: ExtensionAPI): { router: BodyRouter; dispose: () => void } {
	const router = new BodyRouter();

	// 1. 从宿主同进程共享表拉取世界暴露的具身端点。
	//
	//    刻意采用"拉取 + 订阅"而不是"世界启动时推送"：世界由 world-framework 在内置
	//    capability 阶段装载，可能早于本扩展激活，也可能在运行期被 world_store 停用/
	//    启用而重新暴露。拉取对顺序免疫，订阅覆盖后续变化。
	const registered = new Map<string, BodyEndpoint>();

	// 状态变化落史（不唤醒）：摘要变化时 appendCustomEntry，跨回合可见；
	// 空闲时不 submitInput —— 状态变化不值得单独醒一个回合，即时真值由 body / live2d status 查询保证。
	const stateSignature = (): string =>
		JSON.stringify(router.listEndpoints().map((s) => [s.bodyId, s.bodyType, s.online, s.isFocal, s.isPaused]));
	let lastStateSignature = stateSignature();
	const recordStateChange = (reason: string): void => {
		const current = stateSignature();
		if (current === lastStateSignature) return;
		lastStateSignature = current;
		void pi.appendEntry({
			customType: "embodiment.state-change",
			data: { reason, after: router.listEndpoints(), at: new Date().toISOString() },
		});
	};

	const syncExposedEndpoints = (): void => {
		const feed = pi.shared(WORLD_EXPOSED_SHARED_NAME) as WorldExposedRegistry | undefined;

		const present = new Map<string, BodyEndpoint>();
		if (feed) {
			for (const name of feed.names()) {
				if (!name.startsWith(BODY_ENDPOINT_EXPOSED_PREFIX)) continue;
				const value = feed.get(name);
				if (isBodyEndpoint(value)) {
					present.set(name, value);
				} else {
					pi.reportError(
						new Error(`共享名 "${name}" 声明为具身端点，但取到的值不满足 BodyEndpoint 契约，已拒绝注册。`),
					);
				}
			}
		}

		// 先撤下失效登记（被替换或已注销），再登记新增项——顺序不可颠倒，
		// 否则同一 bodyId 的重启会留下旧端点占位。
		for (const [name, endpoint] of [...registered]) {
			if (present.get(name) !== endpoint) {
				router.unregisterEndpoint(endpoint.bodyId);
				registered.delete(name);
				recordStateChange(`端点注销: ${endpoint.bodyId}`);
			}
		}
		for (const [name, endpoint] of present) {
			if (!registered.has(name)) {
				router.registerEndpoint(endpoint);
				registered.set(name, endpoint);
				recordStateChange(`端点注册: ${endpoint.bodyId}`);
			}
		}
	};

	// 先订阅后拉取：订阅建立之前发生的暴露不会被后续拉取错过；拉取本身幂等，
	// 两步顺序颠倒会在"共享表在同步与订阅之间才出现/变更"时留下丢失窗口。
	const exposedFeed = pi.shared(WORLD_EXPOSED_SHARED_NAME) as WorldExposedRegistry | undefined;
	const unsubscribeExposed = exposedFeed?.subscribe(syncExposedEndpoints);
	syncExposedEndpoints();

	// 2. 注册 body 门面工具；操作后比对状态摘要，变化时落史（不唤醒）。
	const bodyTool = createBodyTool(router, recordStateChange);
	const unregisterTool = pi.registerTool(bodyTool);

	// 3. 注册 cue Marker 语法与派发表：Output Interpretation 的 marker 语义事件是
	//    唯一来源；Speech 外的线索按该流语义顺序执行一次，不等待 TTS。
	//    （消费前验证 Body 能力仍有效：离线/暂停端点由 router.dispatchCue 拒绝并报告。）
	pi.registerOutputTag({
		name: "cue",
		kind: "marker",
		attributes: { id: "required-string", target: "optional-string" },
	});

	//    未被任何身体响应的 cue 必须可见——否则「cue 到底通没通」无法判定
	//    （2026-09-21 的真实缺陷正是别名 cue 被静默丢弃，用户只能靠肉眼猜）。
	//    按 cueId 去重：同一未知线索只报一次；一旦之后成功送达就移出集合，
	//    这样同一条线索再失败时还能再次报出来。
	const unhandledCues = new Set<string>();
	const dispatch = (cueId: string, target?: string): void => {
		if (router.dispatchCue(cueId, target)) {
			unhandledCues.delete(cueId);
			return;
		}
		if (unhandledCues.has(cueId)) return;
		unhandledCues.add(cueId);
		const primary = router.getPrimaryEndpoint();
		const known = primary
			? primary
					.affordance()
					.cues.map((c) => c.id)
					.join("、")
			: "（当前没有任何已注册端点）";
		pi.reportError(
			new Error(
				`具身线索 "${cueId}" 未能送达任何身体（无端点声明支持该 id/别名，或身体离线/暂停），已忽略。` +
					`主导身体声明的 cue id: ${known}`,
			),
		);
	};

	const unshareDispatch = pi.share(CUE_DISPATCH_SHARED, {
		dispatch: (cue: { id: string; target?: string }) => dispatch(cue.id, cue.target),
	} satisfies CueDispatcher);

	pi.on("expression", (event) => {
		const e = event.event;
		// 只有位于任何 Block 之外的 marker 归具身直接执行；Block 内的线索是语音的
		// 时间锚点，由 Speech 按音频事实或文本降级路径驱动。
		if (e.kind !== "marker" || e.blockId !== undefined || e.name !== "cue") return;
		const id = e.attributes.id;
		if (!id) return;
		dispatch(id, e.attributes.target);
	});

	// 4. 监听打断信号，回合格断：interrupt 取消瞬时动作并保留槽位与自律——
	//    不再 safeStop（急停会暂停身体，过度惩罚一次回合打断；边界规范 §5）。
	//    进程收尾（pi.signal abort）仍走 stopAll 急停，属显式拆除语义。
	pi.on("turn_aborted", () => {
		void router.interruptAll();
	});

	const onAbort = () => {
		void router.stopAll();
	};
	pi.signal.addEventListener("abort", onAbort);

	// 5. 模型信息环境：cue 语法 Guidance（文件式）。
	//    合法 Cue ID 不再动态注入（S7 收口）：各身体由自己的扩展 Guidance 描述合法
	//    线索；运行时可用集按需经 body 工具（status）查询，未送达的 cue 由诊断报告
	//    列出主导身体声明的 cue id。不建立独立 Cue 目录或动态枚举服务。
	const guidance = pi.provideContext({
		id: "cue-guide",
		kind: "guidance",
		file: "prompts/cue.md",
	});
	void guidance.catch((error) =>
		pi.reportError(`[Embodiment] 线索指南注册失败: ${error instanceof Error ? error.message : String(error)}`),
	);

	const dispose = () => {
		unshareDispatch();
		unsubscribeExposed?.();
		for (const endpoint of registered.values()) {
			router.unregisterEndpoint(endpoint.bodyId);
		}
		registered.clear();
		unregisterTool?.();
		pi.signal.removeEventListener("abort", onAbort);
		void router.stopAll();
	};

	return { router, dispose };
}

export default activateEmbodimentExtension;
