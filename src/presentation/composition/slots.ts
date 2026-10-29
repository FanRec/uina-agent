/**
 * Composition 槽位注册表（平台中立）。
 *
 * 只处理 SlotContribution（中立 payload + 优先级 + TTL + 去重键）与 SlotAck 回执；
 * 不 import Component，不接收 render(width)，不自行读时钟——TTL 由 surface 以
 * `expire(at)` 心跳推进。行渲染是 Surface 的事（TUI 在 src/ui/composition/render.ts）。
 */

export type SlotId = "header" | "footer" | "notice" | "activity" | "toast" | "above" | "below";

export type SlotLevel = "info" | "warning" | "error";

/** 中立载荷：不含任何渲染函数或终端组件；custom 类型的组件解析属具体 Surface。 */
export type SlotPayload =
	| { kind: "text"; text: string; level?: SlotLevel; tone?: "copy" }
	| { kind: "activity"; label: string; startedAt?: number; detail?: string }
	| { kind: "notice"; text: string; level: SlotLevel; dedupeKey?: string };

export interface SlotContribution {
	id: string;
	slot: SlotId;
	priority: number;
	ttlMs?: number;
	dedupeKey?: string;
	payload: SlotPayload;
}

/** 回执只表示"已被 Registry 受理/被去重/被顶掉/已过期"，不承诺像素可见。 */
export interface SlotAck {
	accepted: boolean;
	reason?: "shadowed" | "expired" | "overflow";
}

interface LiveEntry {
	contribution: SlotContribution;
	publishedAt?: number;
	/** 同 slot 内的插入序：toast 满员时先淘汰更旧者。 */
	seq: number;
}

export interface SlotRegistry {
	publish(contribution: SlotContribution, at?: number): SlotAck;
	retract(id: string): void;
	/** 由 surface 心跳/定时器调用，返回本次过期并移除的贡献 id。 */
	expire(at: number): readonly string[];
	snapshot(slot?: SlotId): readonly SlotContribution[];
}

const TOAST_CAPACITY = 3;

export function createSlotRegistry(): SlotRegistry {
	const live = new Map<string, LiveEntry>();
	let seq = 0;

	const bySlot = (slot: SlotId): LiveEntry[] => [...live.values()].filter((entry) => entry.contribution.slot === slot);

	const hasDedupe = (key: string): boolean => [...live.values()].some((entry) => entry.contribution.dedupeKey === key);

	return {
		publish(contribution, at) {
			if (contribution.dedupeKey !== undefined && hasDedupe(contribution.dedupeKey)) {
				return { accepted: false, reason: "shadowed" };
			}
			// header/footer 语义：最新覆盖（同槽旧贡献移除，不另发回执）。
			if (contribution.slot === "header" || contribution.slot === "footer") {
				for (const entry of bySlot(contribution.slot)) live.delete(entry.contribution.id);
			}
			// toast 语义：队列容量 3，超员先淘汰优先级最低、再淘汰最旧。
			if (contribution.slot === "toast") {
				const toasts = bySlot("toast");
				if (toasts.length >= TOAST_CAPACITY) {
					const evictable = toasts.filter((entry) => entry.contribution.id !== contribution.id);
					evictable.sort((a, b) => {
						const byPriority = a.contribution.priority - b.contribution.priority;
						return byPriority !== 0 ? byPriority : a.seq - b.seq;
					});
					const overflow = toasts.length - TOAST_CAPACITY + 1;
					for (const entry of evictable.slice(0, overflow)) live.delete(entry.contribution.id);
				}
			}
			live.set(contribution.id, { contribution, publishedAt: at, seq: ++seq });
			return { accepted: true };
		},

		retract(id) {
			live.delete(id);
		},

		expire(at) {
			const expired: string[] = [];
			for (const [id, entry] of live) {
				const { ttlMs, id: cid } = entry.contribution;
				if (ttlMs === undefined || entry.publishedAt === undefined) continue;
				if (at - entry.publishedAt >= ttlMs) {
					live.delete(id);
					expired.push(cid);
				}
			}
			return expired;
		},

		snapshot(slot) {
			const entries = slot === undefined ? [...live.values()] : bySlot(slot);
			const sorted = [...entries].sort((a, b) => {
				if (a.contribution.slot === "toast" && b.contribution.slot === "toast") {
					// toast 展示序：优先级高在上；同级新在上。
					const byPriority = b.contribution.priority - a.contribution.priority;
					return byPriority !== 0 ? byPriority : b.seq - a.seq;
				}
				if (a.contribution.slot === "activity" && b.contribution.slot === "activity") {
					const byPriority = b.contribution.priority - a.contribution.priority;
					return byPriority !== 0 ? byPriority : a.seq - b.seq;
				}
				return a.seq - b.seq;
			});
			return sorted.map((entry) => entry.contribution);
		},
	};
}
