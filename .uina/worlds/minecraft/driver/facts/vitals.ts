/** Connection-local received effect lifetimes; shared by self and feedback. */
import type { MineflayerBot } from "../mineflayer/adapter.js";

type Effect = { id: number; amplifier?: number; duration?: number };
type Tracked = { effect: Effect; until: number | null };
const trackers = new WeakMap<MineflayerBot, ReturnType<typeof createTracker>>();

function createTracker(bot: MineflayerBot) {
	const active = new Map<number, Tracked>();
	const listeners = new Set<() => void>();
	const remember = (effect: Effect) =>
		active.set(effect.id, {
			effect,
			until: effect.duration == null || effect.duration < 0 ? null : performance.now() + effect.duration * 50,
		});
	for (const effect of Object.values(bot.entity?.effects ?? {})) remember(effect);
	const changed = () => {
		for (const listener of listeners) listener();
	};
	const add = (entity: unknown, effect: Effect) => {
		if (entity !== bot.entity) return;
		remember(effect);
		changed();
	};
	const remove = (entity: unknown, effect: Effect) => {
		if (entity !== bot.entity) return;
		active.delete(effect.id);
		changed();
	};
	const reset = () => {
		active.clear();
		changed();
	};
	const expire = () => {
		let removed = false;
		for (const [id, entry] of active)
			if (entry.until != null && performance.now() >= entry.until) {
				active.delete(id);
				removed = true;
			}
		if (removed) changed();
	};
	const handlers: [string, (...args: never[]) => void][] = [
		["entityEffect", add as never],
		["entityEffectEnd", remove as never],
		["respawn", reset],
		["physicsTick", expire],
	];
	for (const [name, fn] of handlers) bot.on(name as never, fn as never);
	const end = () => {
		for (const [name, fn] of handlers) bot.removeListener(name as never, fn as never);
		bot.removeListener("end", end);
		listeners.clear();
	};
	bot.on("end", end);
	return {
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		effects() {
			return [...active.values()]
				.filter((e) => e.until == null || e.until > performance.now())
				.map((e) => ({
					...e.effect,
					seconds: e.until == null ? null : Math.max(0, (e.until - performance.now()) / 1000),
				}));
		},
	};
}

export function trackVitals(bot: MineflayerBot) {
	let tracker = trackers.get(bot);
	if (!tracker) {
		tracker = createTracker(bot);
		trackers.set(bot, tracker);
	}
	return tracker;
}

export function effectiveAttribute(attribute: unknown): number | null {
	const value = attribute as { value?: number; modifiers?: { operation: number; amount: number }[] } | undefined;
	if (!value || !Number.isFinite(value.value)) return null;
	const mods = value.modifiers ?? [];
	if (mods.some((m) => ![0, 1, 2].includes(m.operation) || !Number.isFinite(m.amount))) return null;
	const base = value.value! + mods.filter((m) => m.operation === 0).reduce((s, m) => s + m.amount, 0);
	const scaled = base * (1 + mods.filter((m) => m.operation === 1).reduce((s, m) => s + m.amount, 0));
	const result = mods.filter((m) => m.operation === 2).reduce((s, m) => s * (1 + m.amount), scaled);
	return Number.isFinite(result) ? result : null;
}
