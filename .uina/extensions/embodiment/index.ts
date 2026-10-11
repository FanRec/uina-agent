import { CUE_DISPATCH_SHARED, CUE_PLAYBACK_OWNER_SHARED, type CuePlaybackOwner } from "./playback-cues.js";
import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import { WORLD_EXPOSED_SHARED_NAME, type WorldExposedRegistry } from "../../../src/extensions/world-framework/types.js";
import { BodyRouter } from "./body-router.js";
import { StreamingTagStripper } from "./tag-stripper.js";
import { createBodyTool } from "./tools.js";
import { BODY_ENDPOINT_EXPOSED_PREFIX, type BodyEndpoint } from "./types.js";

export * from "./types.js";
export * from "./body-router.js";
export * from "./tag-stripper.js";
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
 */
export function activateEmbodimentExtension(pi: ExtensionAPI): { router: BodyRouter; dispose: () => void } {
	const router = new BodyRouter();
	const stripper = new StreamingTagStripper();

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
	// 两步顺序颠倒会在“共享表在同步与订阅之间才出现/变更”时留下丢失窗口。
	const exposedFeed = pi.shared(WORLD_EXPOSED_SHARED_NAME) as WorldExposedRegistry | undefined;
	const unsubscribeExposed = exposedFeed?.subscribe(syncExposedEndpoints);
	syncExposedEndpoints();

	// 2. 注册 body 门面工具；操作后比对状态摘要，变化时落史（不唤醒）。
	const bodyTool = createBodyTool(router, recordStateChange);
	const unregisterTool = pi.registerTool(bodyTool);

	// 3. 监听输出流，流式剥离并分发 <cue> 标签。
	//    只消费 cues：清洗后的正文由 voice/tts 各自的清洗器独立负责，此处不做二手转交。
	//
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
	});
	const playbackOwnsOutput = (event: object) =>
		(pi.shared(CUE_PLAYBACK_OWNER_SHARED) as CuePlaybackOwner | undefined)?.ownsOutput(event) === true;
	pi.on("turn_start", () => stripper.reset());
	pi.on("output_update", (event) => {
		if (event.channel === "content") {
			const { cues } = stripper.processChunk(event.text);
			for (const cue of cues) {
				if (!playbackOwnsOutput(event)) dispatch(cue.id, cue.target);
			}
		}
	});

	pi.on("output_end", (event) => {
		if (event.channel === "content") {
			const { cues } = stripper.flush();
			for (const cue of cues) {
				if (!playbackOwnsOutput(event)) dispatch(cue.id, cue.target);
			}
		}
	});

	// 4. 注册 Markdown 转换器：在渲染层剔除输出中的 <cue id="..."/> 标签，
	//    确保 TUI / Markdown 渲染视图干净自然，不泄露动作标签代码给终端用户。
	const unregisterMarkdown = pi.registerMarkdownTransformer?.("embodiment.strip-cues", (md) =>
		md.replace(/<\s*cue\b[^>]*?\/?>/gi, ""),
	);

	// 5. 监听打断信号，回合格断：interrupt 取消瞬时动作并保留槽位与自律——
	//    不再 safeStop（急停会暂停身体，过度惩罚一次回合打断；边界规范 §5）。
	//    进程收尾（pi.signal abort）仍走 stopAll 急停，属显式拆除语义。
	pi.on("turn_aborted", () => {
		stripper.reset();
		void router.interruptAll();
	});

	const onAbort = () => {
		void router.stopAll();
	};
	pi.signal.addEventListener("abort", onAbort);

	const dispose = () => {
		unshareDispatch();
		unsubscribeExposed?.();
		for (const endpoint of registered.values()) {
			router.unregisterEndpoint(endpoint.bodyId);
		}
		registered.clear();
		unregisterTool?.();
		unregisterMarkdown?.();
		pi.signal.removeEventListener("abort", onAbort);
		void router.stopAll();
	};

	return { router, dispose };
}

export default activateEmbodimentExtension;
