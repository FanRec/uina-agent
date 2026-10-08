import type { WorldDef, ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { loadQqWorldConfig, type QqWorldConfig } from "./config.js";
import { FactsJournal } from "./facts-journal.js";
import { ControlStore } from "./control-store.js";
import { OperationLog } from "./operation-log.js";
import { OneBotTransport, type QqTransport } from "./transport.js";
import { QqIngestion } from "./ingest.js";
import { QqScheduler } from "./scheduler.js";
import { handleQqCall, requestState, type QqAppDeps } from "./app.js";
import { hasGrant } from "./grants.js";
import * as render from "./render.js";
import type { EventFact } from "./types.js";
import { QQ_ACTION_SCHEMAS, QQ_TOOL_DESCRIPTION } from "./tool-schema.js";
import { join } from "node:path";
import { MediaStaging } from "./media.js";

/** 连续性交互窗口（合同 §4 初值 30s）：recall 相关性判定用。 */
const CONTINUITY_WINDOW_MS = 30_000;

/**
 * QQ World 装配：配置 → 存储 → 传输 → 摄取 → 调度 → facade。
 * 启动在绑定、grant、本地存储就绪后注册工具；登录身份与绑定账号不符则启动失败，
 * 不开放平台写入。停止立即取消新机会与重连，结算在途工作。
 */

export function createQqWorld(injected?: {
	config?: QqWorldConfig;
	transport?: QqTransport;
	/** 测试注入配置路径；缺省读 world 目录 config.json。 */
	configPath?: string;
}): WorldDef {
	// 配置在 onStart 校验：工厂阶段绝不抛错，否则 world 在发现期注册失败，
	// 用户只会看到 world_not_found 而看不到真实原因。
	let config: QqWorldConfig | null = injected?.config ?? null;
	function requireConfig(): QqWorldConfig {
		if (config) return config;
		const loaded = loadQqWorldConfig(injected?.configPath);
		if (!loaded.ok) throw new Error(`[qq] 配置加载失败：${loaded.error}`);
		config = loaded.config;
		return config;
	}

	let ctxRef: ServiceCompanionContext | null = null;
	let transport: QqTransport | null = injected?.transport ?? null;
	let journal: FactsJournal | null = null;
	let control: ControlStore | null = null;
	let ops: OperationLog | null = null;
	let media: QqAppDeps["media"];
	let ingestion: QqIngestion | null = null;
	let scheduler: QqScheduler | null = null;
	let reviewTimer: ReturnType<typeof setInterval> | null = null;
	let unbindHost: (() => void) | null = null;
	const faceNames = new Map<string, string>();
	let lifecycleGeneration = 0;
	let worldAbort: AbortController | null = null;
	const unbindTransport: (() => void)[] = [];

	function deps(): QqAppDeps {
		const activeConfig = requireConfig();
		return {
			selfId: activeConfig.selfId,
			grants: activeConfig.grants,
			journal: journal!,
			control: control!,
			ops: ops!,
			transport: transport!,
			media,
			display: { ...activeConfig.display, faceNames },
			faceNames,
		};
	}

	const actions: WorldDef["actions"] = {};
	for (const [name, schema] of Object.entries(QQ_ACTION_SCHEMAS)) {
		actions[name] = {
			description: schema.description,
			parameters: schema.parameters as Record<string, unknown>,
			run: (params, ctx) => handleQqCall(deps(), name, params, ctx.signal),
		};
	}

	const world: WorldDef = {
		name: "qq",
		description: QQ_TOOL_DESCRIPTION,
		executionMode: "sequential",
		actions,

		async onStart(context: ServiceCompanionContext): Promise<void> {
			const generation = ++lifecycleGeneration;
			worldAbort = new AbortController();
			const signal = AbortSignal.any([context.signal, worldAbort.signal]);
			function assertRunning(): void {
				if (generation !== lifecycleGeneration || signal.aborted) throw new Error("[qq] World 已停止或取消启动");
			}
			ctxRef = context;
			config = requireConfig();
			const worldDataDir = context.worldDataDir;
			if (!worldDataDir) throw new Error("[qq] 缺少 worldDataDir，无法就绪本地存储");
			const dataDir = join(worldDataDir, "v2", config.selfId);

			journal = new FactsJournal({ dataDir, selfId: config.selfId });
			journal.recover();
			control = new ControlStore({ dataDir, selfId: config.selfId });
			control.load();
			ops = new OperationLog({ dataDir, selfId: config.selfId });
			ops.recover();
			ops.seedCounterFromExisting();
			const staging = new MediaStaging({ stagingDir: join(dataDir, "staging"), ops });
			staging.cleanupSettled();
			media = { allowedRoots: config.media?.allowedRoots ?? [process.cwd(), dataDir], staging };

			scheduler = new QqScheduler({
				selfId: config.selfId,
				journal,
				control,
				now: () => new Date().toISOString(),
				renderBatch: (candidate) => {
					const activeConfig = config;
					return render.renderBatch(candidate, {
						journal: journal!,
						control: control!,
						now: () => new Date().toISOString(),
						display: { ...activeConfig?.display, faceNames },
						settledUnknowns: scheduler?.listSettledUnknowns() ?? [],
					});
				},
				emit: async ({ id, text, conversationRef, cls, origin }) => {
					await ctxRef?.emitEvent?.({
						id,
						type: cls === "internal" ? "qq-internal" : "qq-batch",
						channel: "world",
						delivery: "queued",
						origin,
						text,
						data: { conversationRef },
					});
				},
				isBusy: () => context.isBusy?.() ?? false,
				isRequestPending: (ref) => {
					const fact = journal?.snapshot.requests.get(ref);
					return !!fact && !!ops && requestState({ ops }, fact).state === "pending";
				},
				isRecallRelevant: (fact) => {
					// 合同 §4：recall 仅当"影响当前交互或事项证据"才提醒。操作化规则：
					// ①自身发言（out）被撤——发言证据被毁；②open 事项 evidenceRefs 引用被撤；
					// ③该会话处于连续性交互窗口内（合同初值 30s，最近 committed 批次之后）。
					if (!fact.messageRef) return false;
					const recalled = journal!.getMessage(fact.messageRef);
					if (recalled?.direction === "out") return true;
					if (control!.listFollowUps({ state: "open" }).some((item) => item.evidenceRefs.includes(fact.messageRef!))) {
						return true;
					}
					const notifiedAt = journal!.snapshot.notifiedAt.get(fact.conversationRef ?? "");
					return notifiedAt !== undefined && Date.now() - Date.parse(notifiedAt) <= CONTINUITY_WINDOW_MS;
				},
			});
			// 摄取 → 调度：落库即通知（onFact 回调保证顺序）。
			// 未授 observation：平台事实不入库、不进调度（grant 表：observation 覆盖读取与新事实接收）。
			ingestion = new QqIngestion(
				config.selfId,
				journal,
				(item) => {
					scheduler?.onFact(item);
				},
				hasGrant(config.grants, "observation"),
			);

			transport =
				injected?.transport ?? new OneBotTransport({ connection: config.connection, expectedSelfId: config.selfId });
			unbindTransport.push(
				transport.onEvent((event) => {
					if (generation === lifecycleGeneration) ingestion?.handleEvent(event);
				}),
			);

			// 迟到回执归并（G6）：SDK 超时移除 pending 后，回执只剩 raw 可观察；
			// 凭 echo（=operationRef）升级 unknown，确定结论不被迟到副本覆盖。
			// 只有"unknown 已交付给工具结果"的操作，其升级才通知主体（在途回执不需要）。
			const unbindRaw = transport.onRaw((raw) => {
				if (generation !== lifecycleGeneration) return;
				if (typeof raw !== "string") return;
				try {
					const parsed = JSON.parse(raw) as { echo?: unknown; status?: unknown; retcode?: unknown; data?: unknown };
					if (typeof parsed.echo !== "string") return;
					const before = ops?.getByEcho(parsed.echo);
					const settled = ops?.settleFromEchoReceipt(parsed.echo, parsed, new Date().toISOString());
					if (
						settled &&
						before?.outcome === "unknown" &&
						settled.outcome !== "unknown" &&
						ops?.wasDeliveredUnknown(settled.ref)
					) {
						scheduler?.notifyOperationSettled(settled);
					}
				} catch {
					// 非 JSON raw 帧忽略。
				}
			});
			unbindTransport.push(unbindRaw);

			// 断线/恢复（internal 事件）：稳定故障提醒一次；恢复只对先前已报过的故障。
			let reportedDisconnect = false;
			const unbindStatus = transport.onStatus((status) => {
				if (generation !== lifecycleGeneration) return;
				if (!scheduler || !journal || !config) return;
				const kind = status.connected ? "transport_recovered" : "transport_disconnected";
				if (status.connected ? !reportedDisconnect : reportedDisconnect) return;
				reportedDisconnect = !status.connected;
				const fact: EventFact = {
					ref: journal.mintEventRef(),
					kind,
					time: new Date().toISOString(),
					summary: status.error,
					source: "internal",
				};
				journal.appendEvent(fact);
				scheduler.onFact({ kind: "event", fact });
			});
			unbindTransport.push(unbindStatus);

			// Host 事实事件：input_settled 释放占位并记账；agent_settled 驱动 busy recheck。
			unbindHost =
				context.onHostEvent?.((event) => {
					if (event.type === "input_settled") {
						const inputId = (event as unknown as { inputId: string }).inputId;
						const outcome = (event as { outcome?: string }).outcome;
						scheduler?.onInputSettled(inputId, outcome === "committed");
					}
					if (event.type === "agent_settled") {
						scheduler?.onAgentSettled();
					}
				}) ?? null;

			// 身份核验：登录身份不符阻止平台写入（启动失败）。
			const identity = await transport.start(signal);
			assertRunning();
			if (String(identity.selfId) !== config.selfId) {
				await transport.stop();
				throw new Error(
					`[qq] 登录身份 ${identity.selfId} 与绑定账号 ${config.selfId} 不符，阻止平台写入；旧引用不转移到新账号。`,
				);
			}

			world.description = `${QQ_TOOL_DESCRIPTION} 当前 QQ 账号：${config.selfId}。`;
			if (hasGrant(config.grants, "observation")) {
				// Optional enrichment; directory failures never prevent the World from starting.
				await handleQqCall(
					deps(),
					"observe",
					{ account: config.selfId, scope: "expressions", kind: "face" },
					signal,
				).catch(() => {});
			}
			assertRunning();

			// 控制状态 tick（60s 粒度即可：预约是分钟级概念）：follow_up 到期 + 暂停到期积压摘要。
			// 启动即查一次：离线期间到期的事项不等首个 60s 周期。
			reviewTimer = setInterval(() => {
				scheduler?.notifyControlTick();
			}, 60_000);
			scheduler?.notifyControlTick();
		},

		async onStop(): Promise<void> {
			lifecycleGeneration++;
			worldAbort?.abort();
			worldAbort = null;
			for (const unsubscribe of unbindTransport.splice(0)) unsubscribe();
			scheduler?.stop();
			scheduler = null;
			if (reviewTimer) {
				clearInterval(reviewTimer);
				reviewTimer = null;
			}
			unbindHost?.();
			unbindHost = null;
			await transport?.stop();
			transport = null;
			ingestion = null;
			journal = null;
			control = null;
			ops = null;
			media = undefined;
			ctxRef = null;
			faceNames.clear();
		},
	};
	return world;
}

export default createQqWorld;
