import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import {
	APP_EXPOSED_SHARED_NAME,
	type AppExposedRegistry,
} from "../../../src/extensions/app-framework/types.js";
import { buildEventFrameGroup, snapshotNotice, contentAddressedEventId } from "../../../src/extensions/event-frames/projection.js";
import { BodyRouter } from "./body-router.js";
import { StreamingTagStripper } from "./tag-stripper.js";
import { projectEmbodimentContext } from "./context-projector.js";
import { createBodyTool } from "./tools.js";
import { BODY_ENDPOINT_EXPOSED_PREFIX, type BodyEndpoint } from "./types.js";

export * from "./types.js";
export * from "./body-router.js";
export * from "./tag-stripper.js";
export * from "./context-projector.js";
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
		typeof candidate.safeStop === "function"
	);
}

/**
 * 激活具身扩展 (Embodiment Extension)
 */
export function activateEmbodimentExtension(pi: ExtensionAPI): { router: BodyRouter; dispose: () => void } {
	const router = new BodyRouter();
	const stripper = new StreamingTagStripper();

	// 1. 从宿主同进程共享表拉取应用暴露的具身端点。
	//
	//    刻意采用"拉取 + 订阅"而不是"应用启动时推送"：应用由 app-framework 在内置
	//    capability 阶段装载，可能早于本扩展激活，也可能在运行期被 app_store 停用/
	//    启用而重新暴露。拉取对顺序免疫，订阅覆盖后续变化。
	const registered = new Map<string, BodyEndpoint>();

	// 状态变化落史（不唤醒）：摘要变化时 appendCustomEntry，跨回合可见；
	// 空闲时不 submitInput —— 设计 §10：状态变化不值得单独醒一个回合，
	// 请求级实时性由 tail 帧保证，即时真值由 body status 查询保证。
	const stateSignature = (): string =>
		JSON.stringify(
			router.listEndpoints().map((s) => [s.bodyId, s.bodyType, s.online, s.isFocal, s.isPaused]),
		);
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
		const feed = pi.shared(APP_EXPOSED_SHARED_NAME) as AppExposedRegistry | undefined;

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
	const exposedFeed = pi.shared(APP_EXPOSED_SHARED_NAME) as AppExposedRegistry | undefined;
	const unsubscribeExposed = exposedFeed?.subscribe(syncExposedEndpoints);
	syncExposedEndpoints();

	// 2. 注册 body 门面工具；操作后比对状态摘要，变化时落史（不唤醒）。
	const bodyTool = createBodyTool(router, recordStateChange);
	const unregisterTool = pi.registerTool(bodyTool);

	// 3. 尾部相位（tail）：具身状态快照以 external_event_frame 三消息组注入完整上下文末尾。
	//    【不可门控】tail 帧瞬态不落 Session，每请求现做现用——它是"当前状态"的唯一载体，
	//    若"与上轮相同就不投"，后续请求的上下文里将完全没有具身信息（cue 列表是发动作
	//    标签的行为必需品）。稳定性由 contentAddressedEventId 承担：内容不变 ⇒ eventId 不变
	//    ⇒ 逐字节稳定 ⇒ 前缀缓存命中，这才是瞬态层正确的零成本机制。
	//    行为规范句（"离线时如实告知"等）不在快照内逐轮复读，经 turn.prepare 追加进
	//    systemPrompt 一次常驻（读后拼接，不覆盖宿主装配的既有提示词；host 链式传入
	//    累积后的 currentPrompt，安全）。
	const unhookPrepare = pi.onHook("turn.prepare", async (input) => ({
		systemPrompt: `${input.systemPrompt}\n[具身规范] 身体离线时，伴随动作自动挂起；被问及身体状态时，如实告知。日常说话中适度自然流露动作即可，请勿在每句话中生硬堆砌动作标签。`,
	}));
	const unhookTransformContext = pi.onHook("turn.transformContext", async (projection) => {
		const contextText = projectEmbodimentContext(router);
		if (!contextText) {
			return undefined;
		}
		return {
			projection: {
				...projection,
				messages: [
				...projection.messages,
				...buildEventFrameGroup({
					eventId: contentAddressedEventId("embodiment-state", contextText),
					text: contextText,
					notice: snapshotNotice("具身状态感知"),
					source: { kind: "runtime", type: "embodiment-state", origin: "external" },
				}),
				],
			},
		};
	}, { tail: true });

	// 4. 监听输出流，流式剥离并分发 <cue> 标签。
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
			? primary.affordance().cues.map((c) => c.id).join("、")
			: "（当前没有任何已注册端点）";
		pi.reportError(
			new Error(
				`具身线索 "${cueId}" 未能送达任何身体（无端点声明支持该 id/别名，或身体离线/暂停），已忽略。` +
					`主导身体声明的 cue id: ${known}`,
			),
		);
	};

	pi.on("output_update", (event) => {
		if (event.channel === "content") {
			const { cues } = stripper.processChunk(event.text);
			for (const cue of cues) {
				dispatch(cue.id, cue.target);
			}
		}
	});

	pi.on("output_end", (event) => {
		if (event.channel === "content") {
			const { cues } = stripper.flush();
			for (const cue of cues) {
				dispatch(cue.id, cue.target);
			}
		}
	});

	// 5. 注册 Markdown 转换器：在渲染层剔除输出中的 <cue id="..."/> 标签，
	//    确保 TUI / Markdown 渲染视图干净自然，不泄露动作标签代码给终端用户。
	const unregisterMarkdown = pi.registerMarkdownTransformer?.(
		"embodiment.strip-cues",
		(md) => md.replace(/<\s*cue\b[^>]*?\/?>/gi, ""),
	);

	// 6. 监听打断信号，全身体急停
	pi.on("turn_aborted", () => {
		stripper.flush();
		void router.stopAll();
	});

	const onAbort = () => {
		void router.stopAll();
	};
	pi.signal.addEventListener("abort", onAbort);

	const dispose = () => {
		unsubscribeExposed?.();
		for (const endpoint of registered.values()) {
			router.unregisterEndpoint(endpoint.bodyId);
		}
		registered.clear();
		unregisterTool?.();
		unregisterMarkdown?.();
		unhookPrepare?.();
		unhookTransformContext?.();
		pi.signal.removeEventListener("abort", onAbort);
		void router.stopAll();
	};

	return { router, dispose };
}

export default activateEmbodimentExtension;
