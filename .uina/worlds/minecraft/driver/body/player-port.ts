/**
 * PlayerPort：Body 资格闸门与 chat 旁路（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4、modules/driver.md §5、§7.7、§10。
 * Runtime 是 acquire 的唯一调用方；同一时刻至多一个有效 Body 资格，违约为
 * CONTROL_CONFLICT（§5.1 调度违约）。上次会话无法证明停止屏障时，拒绝在同一
 * 连接上授予新资格（§10.5）；连接更换后旧写入随旧连接消亡，疑虑作废。
 * acquire signal 桥接到会话退役：外部取消触发同步 revoke + 挂起结算。
 * chat 不占 Body，单独核验连接与输入；§7.7：派发前按版本校验单行与长度上限，
 * 不让上游自动分行/切段；内部排队版本按派发不明记 unknown，不假造 sent。
 * 低层完成合同名（body.chat@1）由 Driver 拥有；公开能力合同归 chat@1 能力层。
 */

import type { BodySession, ControlOwner, PlayerPort, SelfState } from "../../contracts/body.js";
import type { ClientWindowObservation } from "../../contracts/client-facts.js";
import type { ControlRetirement, DriverExecutionSink } from "../../contracts/runtime.js";
import type { EffectReceipt, Fact, Ref } from "../../contracts/values.js";
import type { DriverControlArbiter } from "../control-arbiter.js";
import { EffectRecorder, fail } from "../execution.js";
import type { MineflayerBot } from "../mineflayer/adapter.js";
import { BodySessionImpl, type HostView } from "./session.js";

export interface PlayerPortDeps {
	prepareFeedback?: import("../../contracts/body.js").PrepareFeedback;
	assertActionAllowed: () => void;
	requireRetirement?: (notice: ControlRetirement) => void;
	host: HostView;
	bot: () => MineflayerBot | null;
	/** DriverExecutionSink（public-api §7.1）；返回 null 时锁存 recorder fault 并封闭新副作用。 */
	sink: DriverExecutionSink;
	/** 组合根注入的自采样（与 facts 同一事实源的纯查询）；不可用时返回 null。 */
	sampleSelf: () => Fact<SelfState | null> | null;
	publishWindow?: (observation: ClientWindowObservation | null) => void;
	/** Driver 控制仲裁：Body 资格与受控独占操作（goto）单槽互斥。 */
	arbiter: DriverControlArbiter;
	/** Driver 级唯一发号：body:/op:/eff: 空间跨会话单调，保证 EffectRecord 引用不碰撞。 */
	mintBody: () => Ref;
	mintOp: () => Ref;
	mintEff: () => Ref;
}

export class PlayerPortImpl implements PlayerPort {
	private readonly deps: PlayerPortDeps;
	private current: BodySessionImpl | null = null;
	/** 屏障不成立的会话所属连接；仅在同一连接上阻止新资格（§10.5）。 */
	private brokenBarrierConnection: Ref | null = null;
	private readonly recorder: EffectRecorder;

	constructor(deps: PlayerPortDeps) {
		this.deps = deps;
		this.recorder = new EffectRecorder(deps.sink);
	}

	async acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession> {
		this.deps.assertActionAllowed();
		if (this.recorder.isFaulted) {
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: "effect recorder faulted; new side effects are sealed",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		const identity = this.deps.host.identity;
		// 屏障疑虑只绑定当时的连接；连接已更换/消亡即作废（旧写入无处可达）
		if (this.brokenBarrierConnection != null) {
			const sameConnection = identity != null && identity.connection === this.brokenBarrierConnection;
			if (sameConnection) {
				throw fail({
					code: "CONTROL_INVALID",
					source: "capability",
					message: "a previous body session on this connection could not prove its stop barrier",
					hint: "reconnect the client before acquiring a new qualification",
					dispatch: "not_sent",
					recoverable: false,
				});
			}
			this.brokenBarrierConnection = null;
		}
		if (this.current != null && this.current.sessionState !== "closed") {
			throw fail({
				code: "CONTROL_CONFLICT",
				source: "capability",
				message: "another body qualification is still held; close it before acquiring again",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (this.deps.host.state !== "ready") {
			const st = this.deps.host.state;
			throw fail({
				code: st === "disconnected" || st === "faulted" ? "DISCONNECTED" : "WRONG_STATE",
				source: "environment",
				message: `client is ${st}, not ready for a body qualification`,
				dispatch: "not_sent",
				recoverable: st !== "faulted",
			});
		}
		if (identity == null) {
			throw fail({
				code: "WRONG_STATE",
				source: "environment",
				message: "client has no connection identity yet",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (signal.aborted) {
			throw fail({
				code: "INTERRUPTED",
				source: "environment",
				message: "acquire signal already aborted",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		// 控制仲裁：goto 受控独占期间拒绝新资格（调度违约 CONTROL_CONFLICT）
		if (!this.deps.arbiter.tryClaimBody()) {
			throw fail({
				code: "CONTROL_CONFLICT",
				source: "capability",
				message: "a controlled navigation operation is active; wait for it to finish",
				dispatch: "not_sent",
				recoverable: false,
			});
		}

		let onAbort: (() => void) | null = null;
		let session: BodySessionImpl;
		try {
			session = new BodySessionImpl(this.deps.mintBody(), owner, {
				assertActionAllowed: this.deps.assertActionAllowed,
				requireRetirement: this.deps.requireRetirement,
				host: this.deps.host,
				sink: this.deps.sink,
				sampleSelf: this.deps.sampleSelf,
				prepareFeedback: this.deps.prepareFeedback,
				publishWindow: this.deps.publishWindow,
				bot: this.deps.bot,
				mintOp: this.deps.mintOp,
				mintEff: this.deps.mintEff,
				onClosed: (barrierProven) => {
					if (onAbort != null) signal.removeEventListener("abort", onAbort);
					this.deps.arbiter.releaseBody();
					if (this.current === session) this.current = null;
					if (!barrierProven) {
						this.brokenBarrierConnection = identity.connection;
					}
					if (session.isRecorderFaulted) this.recorder.markFaulted();
				},
			});
		} catch (err) {
			this.deps.arbiter.releaseBody(); // 构造失败不泄漏资格槽
			throw err;
		}
		this.current = session;

		// 外部取消桥接：立即退役（revoke 同步段即刻拒绝旧写入），挂起结算在 close 内完成
		onAbort = () => {
			void session.close();
		};
		signal.addEventListener("abort", onAbort, { once: true });

		// 授予后重查：构造与监听之间无 await，此为同步防御；失效立即退役再报中断
		if (signal.aborted) {
			await session.close();
			throw fail({
				code: "INTERRUPTED",
				source: "environment",
				message: "acquire aborted during qualification grant",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		return session;
	}

	async chat(text: string, signal: AbortSignal): Promise<EffectReceipt> {
		this.deps.assertActionAllowed();
		if (this.recorder.isFaulted) {
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: "effect recorder faulted; new side effects are sealed",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (signal.aborted) {
			throw fail({
				code: "INTERRUPTED",
				source: "environment",
				message: "chat aborted before dispatch",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (this.deps.host.state !== "ready") {
			const st = this.deps.host.state;
			throw fail({
				code: st === "disconnected" || st === "faulted" ? "DISCONNECTED" : "WRONG_STATE",
				source: "environment",
				message: `client is ${st}, not ready for chat`,
				dispatch: "not_sent",
				recoverable: st !== "faulted",
			});
		}
		const bot = this.deps.bot();
		if (bot == null) {
			throw fail({
				code: "DISCONNECTED",
				source: "environment",
				message: "client is gone",
				dispatch: "not_sent",
				recoverable: false,
			});
		}

		// §7.7：派发前按版本校验，不让上游自动分行/切段（尤其长指令不得拆成多条）
		if (text.length === 0) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "chat text must not be empty",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (text.includes("\n")) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "chat text must be a single line; upstream would auto-split it into multiple sends",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const limit: number = bot.supportFeature("lessCharsInChat") ? 100 : 256;
		if (text.length > limit) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `chat text exceeds the version chat limit of ${limit} code units`,
				hint: "driver rejects instead of splitting; shorten the text or send it as multiple calls",
				dispatch: "not_sent",
				recoverable: true,
			});
		}

		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		// 1.21.11 无主线程排队：bot.chat 同步直写协议层；排队版本按派发不明处理（§7.7）
		const queuedToMainThread = bot.supportFeature("chatCommandsQueuedToMainThread") === true;
		try {
			bot.chat(text);
		} catch (err) {
			// 上游仅在写包前抛错（play 状态前置检查）；此时未派发
			this.recorder.record(eff, op, "body.chat@1", "dispatch", "not_sent", "unknown", {
				text,
				detail: `upstream chat rejected: ${err instanceof Error ? err.message : String(err)}`,
			});
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: `chat dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
				dispatch: "not_sent",
				effects: [eff],
				recoverable: false,
			});
		}
		const dispatch: EffectReceipt["dispatch"] = queuedToMainThread ? "unknown" : "sent";
		this.recorder.record(eff, op, "body.chat@1", "dispatch", dispatch, "unknown", {
			text,
			isCommand: text.startsWith("/"),
			completionContract: queuedToMainThread
				? "message queued to main thread; actual protocol dispatch observed later"
				: "single write handed to the protocol layer, no upstream splitting",
		});
		if (queuedToMainThread) {
			return { effect: eff, dispatch: "unknown", completion: "unknown", evidence: [] };
		}
		this.recorder.record(eff, op, "body.chat@1", "receipt", "sent", "met", {
			completionContract:
				"text dispatched to the protocol layer; server delivery or command effects are separate facts",
		});
		return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
	}
}
