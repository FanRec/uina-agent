import type { WorldDef, ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { loadQqWorldConfig, type QqWorldConfig } from "./config.js";
import { FactsJournal } from "./facts-journal.js";
import { ControlStore } from "./control-store.js";
import { OperationLog } from "./operation-log.js";
import { OneBotTransport, type QqTransport } from "./transport.js";
import { QqIngestion } from "./ingest.js";
import { QqScheduler } from "./scheduler.js";
import { handleQqCall, type QqAppDeps } from "./app.js";
import * as render from "./render.js";
import type { EventFact } from "./types.js";
import { QQ_ACTION_SCHEMAS, QQ_TOOL_DESCRIPTION } from "./tool-schema.js";
import { join } from "node:path";
import { MediaStaging } from "./media.js";

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
	const requireConfig = (): QqWorldConfig => {
		if (config) return config;
		const loaded = loadQqWorldConfig(injected?.configPath);
		if (!loaded.ok) throw new Error(`[qq] 配置加载失败：${loaded.error}`);
		config = loaded.config;
		return config;
	};

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

	const deps = (): QqAppDeps => ({
		selfId: requireConfig().selfId,
		grants: requireConfig().grants,
		journal: journal!,
		control: control!,
		ops: ops!,
		transport: transport!,
		media,
	});

	const actions: WorldDef["actions"] = {};
	for (const [name, schema] of Object.entries(QQ_ACTION_SCHEMAS)) {
		actions[name] = {
			description: schema.description,
			parameters: schema.parameters as Record<string, unknown>,
			run: (params, ctx) => handleQqCall(deps(), name, params, ctx.signal) as Promise<ToolExecutionResult>,
		};
	}

	return {
		name: "qq",
		description: QQ_TOOL_DESCRIPTION,
		executionMode: "sequential",
		actions,

		async onStart(context: ServiceCompanionContext): Promise<void> {
			ctxRef = context;
			config = requireConfig();
			const dataDir = context.worldDataDir;
			if (!dataDir) throw new Error("[qq] 缺少 worldDataDir，无法就绪本地存储");

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
						display: activeConfig?.display,
					});
				},
				emit: async ({ id, text, conversationRef, cls }) => {
					await ctxRef?.emitEvent?.({
						id,
						type: cls === "internal" ? "qq-internal" : "qq-batch",
						channel: "world",
						delivery: "queued",
						origin: cls === "internal" ? "internal" : "external",
						text,
						data: { conversationRef },
					});
				},
				isBusy: () => context.isBusy?.() ?? false,
			});
			// 摄取 → 调度：落库即通知（onFact 回调保证顺序）。
			ingestion = new QqIngestion(config.selfId, journal, (item) => {
				scheduler?.onFact(item as Parameters<QqScheduler["onFact"]>[0]);
			});

			transport = injected?.transport ?? new OneBotTransport({ connection: config.connection });
			transport.onEvent((event) => ingestion?.handleEvent(event));

			// 迟到回执归并（G6）：SDK 超时移除 pending 后，回执只剩 raw 可观察；
			// 凭 echo（=operationRef）升级 unknown，确定结论不被迟到副本覆盖。
			transport.onRaw((raw) => {
				if (typeof raw !== "string") return;
				try {
					const parsed = JSON.parse(raw) as { echo?: unknown; status?: unknown; retcode?: unknown; data?: unknown };
					if (typeof parsed.echo !== "string") return;
					ops?.settleFromEchoReceipt(parsed.echo, parsed, new Date().toISOString());
				} catch {
					// 非 JSON raw 帧忽略。
				}
			});

			// 断线/恢复（internal 事件）：稳定故障提醒一次；恢复只对先前已报过的故障。
			let reportedDisconnect = false;
			transport.onStatus((status) => {
				if (!scheduler || !journal || !config) return;
				const kind = status.connected ? "transport_recovered" : "transport_disconnected";
				if (status.connected ? !reportedDisconnect : reportedDisconnect) return;
				reportedDisconnect = !status.connected;
				const fact: EventFact = {
					ref: `qq-event:${config.selfId}:t-${Date.now()}`,
					kind,
					time: new Date().toISOString(),
					summary: status.error,
					source: "internal",
				};
				journal.appendEvent(fact);
				scheduler.onFact({ kind: "event", fact });
			});

			// 身份核验：登录身份不符阻止平台写入（启动失败）。
			const identity = await transport.start();
			if (String(identity.selfId) !== config.selfId) {
				await transport.stop();
				throw new Error(`[qq] 登录身份 ${identity.selfId} 与绑定账号 ${config.selfId} 不符，阻止平台写入；旧引用不转移到新账号。`);
			}

			// reviewAt 到期轮询（60s 粒度即可：预约是分钟级概念）。
			reviewTimer = setInterval(() => {
				scheduler?.notifyFollowUpDue();
			}, 60_000);

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
		},

		async onStop(): Promise<void> {
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
		},
	};
}

export default createQqWorld;
