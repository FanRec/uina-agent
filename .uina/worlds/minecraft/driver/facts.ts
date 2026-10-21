/**
 * Client Facts：Driver → World 的当前事实入口（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1、modules/driver.md §11。
 * sample() 同步读取同一本地提交边界的只读纯值；不造值：players/map/window 返回
 * null + unknown，实体 metadata/components 未捕获如实为 null。
 * sections() 经 bot.blockAt 逐格构建 palette+indices（与 mineflayer findBlocks
 * 同一扫描策略；代价随加载体量线性增长，I1 场景用小半径）。
 * 选定证据（I1：chat/connection 事件）在流内 mark 从 1 起；evidence_gap 如实发，
 * 不把缺订阅者解释为无事件。reset/epoch 规则见 §4.1 尾段。
 */

import type {
	CapturedClientFact,
	ClientEntitiesValue,
	ClientEvidenceAck,
	ClientEvidenceMark,
	ClientFactCapture,
	ClientFactNotice,
	ClientFactScope,
	ClientFactStamp,
	ClientFactView,
	ClientFactsPort,
	ClientFactsSubscription,
	ClientFactsSubscribeOptions,
	ClientInventoryValue,
	ClientPlayersValue,
	ClientSectionsValue,
	ClientSlotValue,
	ClientBlockValue,
	ClientMapValue,
	SectionTarget,
} from "../contracts/client-facts.js";
import type { EntityRef, SelfState, StatusEffectValue } from "../contracts/body.js";
import type { BlockStateValue, BlockTarget } from "../contracts/body.js";
import type { Fact, FactSource, JsonValue, Ref, Vec3 } from "../contracts/values.js";
import type { ClientHost } from "./client-host.js";
import { fromMineflayerVec3, toMineflayerVec3, type MineflayerBot } from "./mineflayer/adapter.js";

export interface FactsBinding {
	binding: Ref;
	world: Ref;
	worldRevision: Ref;
	/**
	 * 本进程启动的流命名空间（组合根每次启动生成，跨进程不复用）。
	 * world.md §5.3：证据流不可复用——每进程从 1 重来的 `evs:N` 会与持久
	 * 历史库的 (stream, seq) 主键跨启动冲突。不得为空或包含冒号。
	 */
	streamNamespace: string;
}

const MAX_PENDING_EVIDENCE = 1024;

interface PendingEvidence {
	record: CapturedClientFact;
}

/** 每前缀独立单调发号（与 client-host 同约定，但各所有者独立计数）。 */
function makeRefIssuer() {
	const counters = new Map<string, number>();
	return (prefix: string): Ref => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${prefix}:${next}`;
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function refIssuerFrom(start: number): () => number {
	let n = start;
	return () => ++n;
}

interface EvidenceReceiver {
	notify: (n: ClientFactNotice) => void;
	/** 只有消费证据的接收方能推进释放水线（见 subscribe 选项）。 */
	consumesEvidence: boolean;
	/**
	 * 每个证据流各自的已持久水线。换流后序号从 1 重来，
	 * 若沿用单值高水位，旧流的高位会覆盖新流，导致证据在落盘前被释放。
	 */
	durable: Map<Ref, number>;
}

export class FactsSource implements ClientFactsPort {
	private readonly nextRef = makeRefIssuer();
	private readonly nextStreamNo = refIssuerFrom(0);
	private readonly listeners = new Map<Ref, EvidenceReceiver>();
	private readonly pendingEvidence: PendingEvidence[] = [];
	private stamp: ClientFactStamp;
	private _evidenceThrough: ClientEvidenceMark;
	private evidenceSeq = refIssuerFrom(0);
	private evidenceStream: Ref;
	private changedScheduled = false;
	private attachedBot: MineflayerBot | null = null;
	private detachFns: (() => void)[] = [];

	constructor(
		private readonly host: ClientHost,
		private readonly binding: FactsBinding,
	) {
		this.stamp = {
			source: this.nextRef("facts"),
			epoch: this.nextRef("ep"),
			sequence: 0,
			connection: host.identity?.connection ?? null,
			incarnation: host.identity?.incarnation ?? null,
		};
		this.evidenceStream = this.openEvidenceStream();
		this._evidenceThrough = { stream: this.evidenceStream, sequence: 0 };
		// 构造时宿主可能已就绪（后装配）也可能尚未连接；挂接跟随连接生命周期：
		// ready 通知时建立源，disconnected/faulted 时封印旧 bot 引用（§3 状态机）。
		this.attach(host.bot);
		host.on((notice) => {
			if (notice.kind === "state") {
				if (notice.state === "ready") {
					// 新活连接：先换代（stamp 携带新身份），再挂接 bot 开始采样提交。
					this.resetSource("source_rebuilt");
					this.attach(this.host.bot);
				} else if (notice.state === "disconnected" || notice.state === "faulted") {
					// 旧 bot 引用封印：sample 转为 WRONG_STATE，不读死连接。
					this.detach();
					this.resetSource("connection_changed");
				}
				return;
			}
			if (notice.kind === "incarnation_changed") {
				this.resetSource("incarnation_changed");
				return;
			}
		});
	}

	// ---- ClientFactsPort ----

	sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T> {
		if (this.attachedBot == null) {
			throw Object.assign(new Error("client facts source is not attached to a live connection"), {
				code: "WRONG_STATE",
			});
		}
		// read 在同一同步边界内执行；view 闭包不外泄（调用者约定，见 §4.1）。
		const value = read(this.buildView());
		return {
			stamp: { ...this.stamp },
			scope: this.currentScope(),
			evidenceThrough: { ...this._evidenceThrough },
			value,
		};
	}

	subscribe(
		listener: (notice: ClientFactNotice) => void,
		options?: ClientFactsSubscribeOptions,
	): ClientFactsSubscription {
		const receiver = this.nextRef("recv");
		this.listeners.set(receiver, {
			notify: listener,
			consumesEvidence: options?.consumesEvidence === true,
			durable: new Map(),
		});
		return {
			stamp: { ...this.stamp },
			evidenceThrough: { ...this._evidenceThrough },
			acknowledge: (ack: ClientEvidenceAck) => {
				const entry = this.listeners.get(receiver);
				if (entry == null) return;
				// 按 ack 自带的 stream 记账：同 receiver/stream 内不回退，异流互不覆盖。
				const previous = entry.durable.get(ack.stream) ?? 0;
				if (ack.durableThrough <= previous) return;
				entry.durable.set(ack.stream, ack.durableThrough);
				this.releaseAckedEvidence();
			},
			close: () => {
				this.listeners.delete(receiver);
				this.releaseAckedEvidence();
			},
		};
	}

	// ---- 内部：证据与提交 ----

	/**
	 * 供组合根注入 Body（drive.end 等需 Fact<SelfState>）的快速自采样；
	 * 未附着活连接时返回 null，不虚构状态（public-api §4 反馈 self 缺口语义）。
	 */
	sampleSelf(): Fact<SelfState> | null {
		if (this.attachedBot == null) return null;
		try {
			return this.buildView().self() as Fact<SelfState>;
		} catch {
			return null;
		}
	}

	get evidenceThrough(): ClientEvidenceMark {
		return { ...this._evidenceThrough };
	}

	/**
	 * 释放已被全部证据接收方确认持久的材料（world.md §5.4）。
	 * 只看当前流：换流后旧流的确认不授权新流的序号。
	 * 没有证据接收方时不释放——构造前的捕获不能被静默丢弃，溢出如实报 gap。
	 */
	private releaseAckedEvidence(): void {
		const stream = this.evidenceStream;
		let minDurable = Number.POSITIVE_INFINITY;
		for (const entry of this.listeners.values()) {
			if (!entry.consumesEvidence) continue;
			minDurable = Math.min(minDurable, entry.durable.get(stream) ?? 0);
		}
		if (!Number.isFinite(minDurable)) return;
		while (this.pendingEvidence.length > 0) {
			const head = this.pendingEvidence[0].record.mark;
			if (head.stream !== stream || head.sequence > minDurable) break;
			this.pendingEvidence.shift();
		}
	}

	/** 证据流 ref = evs:<namespace>:<n>：namespace 跨进程不复用（§5.3）。 */
	private openEvidenceStream(): Ref {
		const ns = this.binding.streamNamespace;
		if (ns.length === 0 || ns.includes(":")) {
			throw new Error("FactsBinding.streamNamespace must be a non-empty string without ':'");
		}
		return `evs:${ns}:${this.nextStreamNo()}`;
	}

	private resetSource(reason: "connection_changed" | "incarnation_changed" | "source_rebuilt"): void {
		// 旧流封口：只证明源捕获结束，不证明已收到/持久化（§4.1）。
		if (this.pendingEvidence.length > 0) {
			this.deliverNotice({ kind: "evidence_end", through: { ...this._evidenceThrough } });
		}
		this.pendingEvidence.length = 0;
		this.evidenceStream = this.openEvidenceStream();
		this.evidenceSeq = refIssuerFrom(0);
		this._evidenceThrough = { stream: this.evidenceStream, sequence: 0 };
		this.stamp = {
			...this.stamp,
			epoch: this.nextRef("ep"),
			sequence: 0,
			connection: this.host.identity?.connection ?? null,
			incarnation: this.host.identity?.incarnation ?? null,
		};
		this.deliverNotice({
			kind: "reset",
			stamp: { ...this.stamp },
			reason,
		});
	}

	private commit(): void {
		this.stamp = { ...this.stamp, sequence: this.stamp.sequence + 1 };
		if (this.changedScheduled) return;
		this.changedScheduled = true;
		queueMicrotask(() => {
			this.changedScheduled = false;
			this.deliverNotice({ kind: "changed", stamp: { ...this.stamp }, changed: [] });
		});
	}

	private deliverNotice(notice: ClientFactNotice): void {
		for (const entry of [...this.listeners.values()]) {
			try {
				entry.notify(notice);
			} catch {
				// 订阅者异常不进入 Driver 关键路径（§4.1）。
			}
		}
	}

	/** I1 选定证据：chat / connection 事件。 */
	private captureEvent(schema: "client.event@1", payload: JsonValue, unknowns: string[]): void {
		if (this.host.bot == null) return;
		const stream = this.evidenceStream;
		const seq = this.evidenceSeq();
		this._evidenceThrough = { stream, sequence: seq };
		const record: CapturedClientFact = {
			ref: this.nextRef("ev"),
			schema,
			mark: { stream, sequence: seq },
			stamp: { ...this.stamp },
			scope: this.currentScope(),
			fact: {
				value: payload,
				observedAt: nowIso(),
				connection: this.stamp.connection ?? undefined,
				incarnation: this.stamp.incarnation ?? undefined,
				source: "server",
				coverage: "partial",
				unknown: unknowns,
				evidence: [],
			},
		};
		this.pendingEvidence.push({ record });
		this.deliverNotice({ kind: "evidence", records: [record] });
		// 无接收方时缓冲有界；溢出如实发缺口（末端未知），不静默丢弃。
		if (this.pendingEvidence.length > MAX_PENDING_EVIDENCE) {
			const after = this.pendingEvidence[0].record.mark.sequence - 1;
			this.pendingEvidence.shift();
			this.deliverNotice({
				kind: "evidence_gap",
				ref: this.nextRef("gap"),
				stream,
				after,
				through: null,
				reason: "evidence buffer overflow without durable acknowledgement",
			});
		}
	}

	private attach(bot: MineflayerBot | null): void {
		this.detach();
		this.attachedBot = bot;
		if (bot == null) return;
		const on = (event: string, fn: () => void) => {
			bot.on(event as never, fn as never);
			this.detachFns.push(() => bot.removeListener(event as never, fn as never));
		};
		on("move", () => this.commit());
		on("health", () => this.commit());
		on("forcedMove", () => this.commit());
		on("entitySpawn", () => this.commit());
		on("entityDespawn", () => this.commit());
		on("chunkColumnLoad", () => this.commit());
		on("chunkColumnUnload", () => this.commit());
		// 运行时发射为 (text, position, jsonMsg, sender)；类型只声明前三参，sender 走 rest。
		const onMessageStr = (message: string, ...rest: unknown[]) => {
			const sender = rest[2];
			const botName = bot.username;
			const text = String(message);
			// 我方消息回声由 chat 动作核验，不重复捕获（chat 证据归属动作回执）。
			if (sender != null && sender === botName) return;
			this.captureEvent(
				"client.event@1",
				{
					kind: "chat",
					channel: "public",
					text,
					sender: typeof sender === "string" ? { name: sender, uuid: null, entity: null } : null,
					recipient: null,
					self: sender === botName ? true : null,
				},
				["chat channel inferred as public; private/system classification not captured in I1"],
			);
			this.commit();
		};
		bot.on("messagestr", onMessageStr as never);
		this.detachFns.push(() => bot.removeListener("messagestr", onMessageStr as never));
		on("end", () => this.resetSource("connection_changed"));
		// 库存窗口提交：同一函数引用登记/移除。
		const inv = bot.inventory;
		if (inv != null) {
			const onSlotUpdate = () => this.commit();
			inv.on("updateSlot", onSlotUpdate);
			this.detachFns.push(() => inv.removeListener("updateSlot", onSlotUpdate));
		}
		this.commit();
	}

	private detach(): void {
		for (const fn of this.detachFns) {
			try {
				fn();
			} catch {
				// 已断开的监听器移除失败无害
			}
		}
		this.detachFns = [];
		this.attachedBot = null;
	}

	private currentScope(): ClientFactScope {
		return {
			binding: this.binding.binding,
			world: this.binding.world,
			worldRevision: this.binding.worldRevision,
			dimension: this.host.dimension,
		};
	}

	// ---- 视图构建 ----

	private buildView(): ClientFactView {
		const bot = this.attachedBot;
		if (bot == null) throw new Error("facts view requires live bot");
		const scope = this.currentScope();
		const stamp = { ...this.stamp };

		const factBase = (
			unknown: string[],
			source: FactSource | "mixed" = "server",
		): Pick<Fact<never>, "observedAt" | "source" | "coverage" | "unknown" | "evidence"> => ({
			observedAt: nowIso(),
			source,
			coverage: unknown.length > 0 ? "partial" : "complete",
			unknown,
			evidence: [],
		});

		const dimensionRef = (): string | null => {
			const dim = bot.game.dimension;
			return dim ?? null;
		};

		// 方块状态属性统一经 getProperties() 收敛为字符串记录（prismarine 值可为 boolean/number）。
		type MineflayerBlock = NonNullable<ReturnType<MineflayerBot["blockAt"]>>;
		const blockStateOf = (block: MineflayerBlock): BlockStateValue => {
			const raw = block.getProperties() as Record<string, string | number | boolean>;
			const properties: Record<string, string> = {};
			for (const [k, v] of Object.entries(raw)) properties[k] = String(v);
			return { name: block.name, properties };
		};

		const view: ClientFactView = {
			scope: (): ClientFactScope => scope,

			self(): Fact<SelfState | null> {
				const pos = fromMineflayerVec3(bot.entity?.position);
				if (pos == null || bot.entity == null) {
					return {
						value: null,
						...factBase(["entity not available; self state unknown"]),
					} as Fact<SelfState | null>;
				}
				const unknown: string[] = [];
				const velocity = fromMineflayerVec3(bot.entity.velocity) ?? { x: 0, y: 0, z: 0 };
				const health = typeof bot.health === "number" ? bot.health : null;
				const food = typeof bot.food === "number" ? bot.food : null;
				if (health == null) unknown.push("health not received");
				if (food == null) unknown.push("food not received");

				// maxHealth：尝试读实体属性（版本键名差异大），读不到如实 unknown。
				let maxHealth: number | null = null;
				const attrs = (bot.entity as unknown as { attributes?: Record<string, { base?: number }> }).attributes;
				const maxKey =
					attrs != null
						? Object.keys(attrs).find((k) => k.endsWith("max_health") || k.endsWith("maxHealth"))
						: undefined;
				if (maxKey != null && typeof attrs?.[maxKey]?.base === "number") {
					maxHealth = attrs[maxKey].base ?? null;
				} else {
					unknown.push("maxHealth attribute not available");
				}

				const saturation =
					typeof (bot as unknown as { foodSaturation?: number }).foodSaturation === "number"
						? (bot as unknown as { foodSaturation: number }).foodSaturation
						: null;
				if (saturation == null) unknown.push("saturation not received");

				const oxygen =
					typeof (bot as unknown as { oxygen?: number }).oxygen === "number"
						? (bot as unknown as { oxygen: number }).oxygen
						: null;
				if (oxygen == null) unknown.push("oxygen not received");

				// inWater/inLava：脚部方块派生（derived，保留输入依据）。
				let inWater: boolean | null = null;
				let inLava: boolean | null = null;
				const feetBlock = bot.blockAt(bot.entity.position.floored());
				if (feetBlock != null) {
					inWater = feetBlock.name === "water";
					inLava = feetBlock.name === "lava";
				} else {
					unknown.push("inWater/inLava not derivable: feet block not loaded");
				}

				const effects: StatusEffectValue[] = [];
				const rawEffects = bot.entity?.effects ?? {};
				for (const eff of Object.values(rawEffects)) {
					const rec = eff as unknown as { id?: number; amplifier?: number; duration?: number };
					if (typeof rec.id !== "number") {
						unknown.push("effect entry without id");
						continue;
					}
					const name = bot.registry.effects[rec.id]?.name;
					if (name == null) {
						unknown.push(`effect id ${rec.id} not in registry`);
						continue;
					}
					effects.push({
						name: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
						amplifier: rec.amplifier ?? 0,
						seconds: typeof rec.duration === "number" ? rec.duration / 20 : null,
					});
				}
				const xpLevel = bot.experience?.level ?? null;
				if (xpLevel == null) unknown.push("xp level not received");

				const value: SelfState = {
					place: {
						world: scope.world,
						worldRevision: scope.worldRevision,
						dimension: dimensionRef() ?? "unknown",
						position: pos,
					},
					velocity,
					health: health ?? 0,
					food: food ?? 0,
					onGround: bot.entity.onGround === true,
					maxHealth,
					saturation,
					oxygen,
					inWater,
					inLava,
					effects,
					xpLevel,
				};
				// 来源：位置/速度/落地是客户端预测；其余来自服务器包 → mixed + basis。
				return {
					value,
					...factBase(unknown, "mixed"),
					basis: [
						{
							paths: ["/place/position", "/velocity", "/onGround"],
							source: "prediction",
							observedAt: nowIso(),
							evidence: [],
						},
						{
							paths: ["/health", "/food", "/saturation", "/oxygen", "/effects", "/xpLevel", "/place/dimension"],
							source: "server",
							observedAt: nowIso(),
							evidence: [],
						},
					],
					connection: stamp.connection ?? undefined,
					incarnation: stamp.incarnation ?? undefined,
				} as Fact<SelfState | null>;
			},

			inventory(): Fact<ClientInventoryValue | null> {
				const win = bot.inventory;
				if (win == null || win.slots == null) {
					return {
						value: null,
						...factBase(["inventory window not received"]),
					} as Fact<ClientInventoryValue | null>;
				}
				const slots: ClientSlotValue[] = [];
				for (let i = 0; i < win.slots.length; i++) {
					const item = win.slots[i];
					if (item == null) {
						slots.push({ slot: i, known: true, item: null });
						continue;
					}
					slots.push({
						slot: i,
						known: true,
						item: { name: item.name, count: item.count, components: null },
					});
				}
				const unknown: string[] = ["item components not captured in I1"];
				const value: ClientInventoryValue = {
					revision: stamp.sequence,
					layout: {
						slotCount: win.slots.length,
						regions: [
							{ name: "crafting", slots: [0, 1, 2, 3, 4] },
							{ name: "armor", slots: [5, 6, 7, 8] },
							{ name: "main", slots: range(9, 35) },
							{ name: "hotbar", slots: range(36, 44) },
							{ name: "offhand", slots: win.slots.length > 45 ? [45] : [] },
						],
					},
					slots,
					selectedSlot: typeof bot.quickBarSlot === "number" ? bot.quickBarSlot : null,
				};
				return {
					value,
					...factBase(unknown),
					connection: stamp.connection ?? undefined,
					incarnation: stamp.incarnation ?? undefined,
				} as Fact<ClientInventoryValue | null>;
			},

			block(target: BlockTarget): Fact<ClientBlockValue> {
				const pos = toMineflayerVec3(target.block);
				const block = bot.blockAt(pos);
				if (block == null) {
					return {
						value: { target, state: null, sign: null },
						...factBase([`block at ${fmtPos(target.block)} not loaded`]),
					} as Fact<ClientBlockValue>;
				}
				const state: BlockStateValue = blockStateOf(block);
				const unknown: string[] = [];
				const isSign = block.name.includes("sign");
				let sign = null;
				if (isSign) {
					// 牌面数据未捕获：null + unknown，不当空白牌面。
					unknown.push("sign text not captured in I1");
					sign = null;
				}
				return {
					value: { target, state, sign },
					...factBase(unknown),
					connection: stamp.connection ?? undefined,
					incarnation: stamp.incarnation ?? undefined,
				} as Fact<ClientBlockValue>;
			},

			sections(targets: SectionTarget[]): Fact<ClientSectionsValue> {
				const sections: ClientSectionsValue["sections"] = [];
				const unknown: string[] = [];
				for (const target of targets) {
					const origin = target.section;
					const baseOriginX = origin.x * 16;
					const baseOriginY = origin.y * 16;
					const baseOriginZ = origin.z * 16;
					const palette: BlockStateValue[] = [];
					const paletteIndex = new Map<string, number>();
					const indices: (number | null)[] = new Array(4096).fill(null);
					let loaded = true;
					for (let y = 0; y < 16 && loaded; y++) {
						for (let z = 0; z < 16 && loaded; z++) {
							for (let x = 0; x < 16 && loaded; x++) {
								const block = bot.blockAt(
									toMineflayerVec3({ x: baseOriginX + x, y: baseOriginY + y, z: baseOriginZ + z }),
								);
								if (block == null) {
									loaded = false;
									break;
								}
								const state: BlockStateValue = blockStateOf(block);
								const key = state.name + JSON.stringify(state.properties);
								let idx = paletteIndex.get(key);
								if (idx == null) {
									idx = palette.length;
									palette.push(state);
									paletteIndex.set(key, idx);
								}
								indices[y * 256 + z * 16 + x] = idx;
							}
						}
					}
					if (!loaded) {
						unknown.push(`section ${fmtVec(origin)} not fully loaded`);
						sections.push({
							target,
							revision: `sec-rev:${stamp.sequence}`,
							base: null,
							patches: [],
						});
						continue;
					}
					sections.push({
						target,
						revision: `sec-rev:${stamp.sequence}`,
						base: { palette, indices },
						patches: [],
					});
				}
				return {
					value: { sections },
					...factBase(unknown),
					connection: stamp.connection ?? undefined,
					incarnation: stamp.incarnation ?? undefined,
				} as Fact<ClientSectionsValue>;
			},

			entities(): Fact<ClientEntitiesValue> {
				const entities: ClientEntitiesValue["entities"] = [];
				const unknown: string[] = ["entity metadata not captured in I1"];
				for (const entity of Object.values(bot.entities)) {
					const e = entity as unknown as {
						id: number;
						type?: string;
						name?: string;
						uuid?: string;
						position?: { x: number; y: number; z: number };
						velocity?: { x: number; y: number; z: number };
					};
					if (e?.id == null) continue;
					const ref: EntityRef = {
						connection: stamp.connection ?? "unknown",
						incarnation: stamp.incarnation ?? "unknown",
						appearance: `ap:${e.id}`,
						networkId: e.id,
					};
					entities.push({
						ref,
						uuid: e.uuid ?? null,
						type: e.name ?? e.type ?? null,
						position: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
						velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
						metadata: null,
					});
				}
				return {
					value: { extent: "tracked", entities },
					...factBase(unknown),
					connection: stamp.connection ?? undefined,
					incarnation: stamp.incarnation ?? undefined,
				} as Fact<ClientEntitiesValue>;
			},

			players(): Fact<ClientPlayersValue | null> {
				return {
					value: null,
					...factBase(["players list not implemented in I1"]),
				} as Fact<ClientPlayersValue | null>;
			},

			map(_id: number): Fact<ClientMapValue | null> {
				return {
					value: null,
					...factBase(["map data not implemented in I1"]),
				} as Fact<ClientMapValue | null>;
			},

			window(): Fact<import("../contracts/body.js").WindowSnapshot | null> {
				return {
					value: null,
					...factBase(["window snapshots not implemented in I1"]),
				} as Fact<import("../contracts/body.js").WindowSnapshot | null>;
			},
		};

		return view;
	}
}

function range(from: number, to: number): number[] {
	const out: number[] = [];
	for (let i = from; i <= to; i++) out.push(i);
	return out;
}

function fmtVec(v: Vec3): string {
	return `${v.x},${v.y},${v.z}`;
}

function fmtPos(v: Vec3): string {
	return `${v.x},${v.y},${v.z}`;
}
