/** Call-bound views over one Driver session; no second control arbiter or client. */
import type { BodyOps, BodySession, ControlOwner, WindowSession } from "../contracts/body.js";
import { callFailure } from "../contracts/values.js";

export function scopedBody(session: BodySession, scope: { signal: AbortSignal; owner: ControlOwner; guard(): void }) {
	const local = new AbortController();
	const signal = AbortSignal.any([scope.signal, local.signal]);
	const pending = new Set<Promise<unknown>>();
	const windows = new Set<WindowSession>();
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
			close: async (options) => {
				await raw.close(options);
				windows.delete(raw);
			},
		};
	}
	const player = new Proxy(session, {
		get(target, key) {
			if (key === "close" || key === "runScoped") return undefined;
			if (key === "openContainer")
				return (at: Parameters<BodyOps["openContainer"]>[0]) =>
					run(async () => windowView(await target.openContainer(at)));
			if (key === "withInventory")
				return <T>(work: (w: WindowSession) => Promise<T>) =>
					run(() => target.withInventory((w) => work(windowView(w))));
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
