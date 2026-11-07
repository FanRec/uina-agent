/** Call-bound views over one Driver session; no second control arbiter or client. */
import type { BodyOps, BodySession, ControlOwner, FeedbackStream, WindowSession } from "../contracts/body.js";
import { callFailure } from "../contracts/values.js";

export function scopedBody(session: BodySession, scope: { signal: AbortSignal; owner: ControlOwner; guard(): void }) {
	const local = new AbortController();
	const signal = AbortSignal.any([scope.signal, local.signal]);
	const pending = new Set<Promise<unknown>>();
	const windows = new Set<WindowSession>();
	const streams = new Set<FeedbackStream>();
	let using = false,
		ended = false,
		closing: Promise<void> | undefined;
	function guard() {
		scope.guard();
		if (ended || signal.aborted)
			throw callFailure({
				code: "CONTROL_INVALID",
				source: "capability",
				message: "body view is closed",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
	}
	async function run<T>(work: () => Promise<T>): Promise<T> {
		guard();
		const result = session.runScoped({ ...scope, signal, guard }, work);
		pending.add(result);
		void result.then(
			() => pending.delete(result),
			() => pending.delete(result),
		);
		return result;
	}
	function windowView(raw: WindowSession): WindowSession {
		windows.add(raw);
		return {
			snapshot: () => run(() => raw.snapshot()),
			click: (input) => run(() => raw.click(input)),
			selectEnchant: (offer) => run(() => raw.selectEnchant(offer)),
			renameItem: (name) => run(() => raw.renameItem(name)),
			selectTrade: (index) => run(() => raw.selectTrade(index)),
			offers: () => run(() => raw.offers()),
			close: async (options) => {
				await raw.close(options);
				windows.delete(raw);
			},
		};
	}
	const player = new Proxy(session, {
		get(target, key) {
			if (key === "close" || key === "runScoped") return undefined;
			// 只读观察直通：不进 Operation 生命周期，也不当 Promise 包装（同步方法）。
			if (key === "deadEntities") return () => target.deadEntities();
			if (key === "openContainer")
				return (at: Parameters<BodyOps["openContainer"]>[0]) =>
					run(async () => windowView(await target.openContainer(at)));
			if (key === "withInventory")
				return <T>(work: (w: WindowSession) => Promise<T>) =>
					run(() => target.withInventory((w) => work(windowView(w))));
			if (key === "feedback")
				return (sensors: Parameters<BodyOps["feedback"]>[0]) =>
					run(async () => {
						const raw = await target.feedback(sensors);
						streams.add(raw);
						return {
							next: (after, abort) => run(() => raw.next(after, AbortSignal.any([signal, abort]))),
							apply: (frame, input) => run(() => raw.apply(frame, input)),
							close: async () => {
								await raw.close();
								streams.delete(raw);
							},
						} satisfies FeedbackStream;
					});
			if (key === "useItem")
				return (hand: Parameters<BodyOps["useItem"]>[0]) =>
					run(async () => {
						const r = await target.useItem(hand);
						using = true;
						return r;
					});
			if (key === "drive")
				return (input: Parameters<BodyOps["drive"]>[0], ticks: number) =>
					run(async () => {
						// Activation can precede a later sample/timeout failure; cleanup must not depend on return success.
						if (input.use?.mode === "once") using = true;
						return target.drive(input, ticks);
					});
			if (key === "endUse")
				return () =>
					run(async () => {
						const r = await target.endUse();
						using = false;
						return r;
					});
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => run(() => Reflect.apply(value, target, args) as Promise<unknown>);
		},
	}) as BodyOps;
	const close = (): Promise<void> => {
		if (closing) return closing;
		ended = true;
		local.abort();
		closing = (async () => {
			await Promise.allSettled([...streams].map((stream) => stream.close()));
			streams.clear();
			await Promise.allSettled([...windows].map((w) => w.close({ force: true })));
			windows.clear();
			await Promise.allSettled([...pending]);
			if (using) {
				const work = () => session.endUse();
				await session.runScoped({ signal: new AbortController().signal, owner: scope.owner, guard: () => {} }, work);
			}
		})();
		return closing;
	};
	return { player, close };
}
