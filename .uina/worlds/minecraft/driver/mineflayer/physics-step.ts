/** One wrapper over the existing simulator: no new timer, simulation or movement sender. */
import type { MineflayerBot } from "./adapter.js";

interface State {
	control: object;
	yaw: number;
	pitch: number;
	jumpQueued: boolean;
	apply(bot: MineflayerBot): void;
}
interface Physics {
	simulatePlayer(state: State, world: unknown): State;
}
export interface PhysicsSteps {
	subscribe(before: () => void, after: (sequence: number) => void): () => void;
}
const clocks = new WeakMap<MineflayerBot, PhysicsSteps>();
export function physicsSteps(bot: MineflayerBot): PhysicsSteps {
	const old = clocks.get(bot);
	if (old) return old;
	const physics = bot.physics as unknown as Physics;
	if (!physics?.simulatePlayer) throw new Error("client physics simulator is not available");
	const original = physics.simulatePlayer;
	const listeners = new Set<{ before(): void; after(sequence: number): void }>();
	let sequence = 0;
	let clientControl: object | undefined;
	const applyMethods = new WeakMap<State, State["apply"]>();
	const wrapped = function (this: Physics, state: State, world: unknown): State {
		// Pathfinder predicts with a separate control object, without applying to Bot.
		// The first actual apply identifies the client's real control object before
		// any feedback frame can be delivered.
		if (clientControl !== undefined && state.control !== clientControl) return original.call(this, state, world);
		if (clientControl !== undefined && listeners.size) {
			for (const listener of [...listeners]) listener.before();
			// PlayerState was constructed before simulatePlayer. Keys are a shared reference,
			// but view/jump fields must reflect the input installed at this boundary.
			state.yaw = bot.entity.yaw;
			state.pitch = bot.entity.pitch;
			state.jumpQueued = (bot as unknown as { jumpQueued: boolean }).jumpQueued;
		}
		const result = original.call(this, state, world);
		const apply = applyMethods.get(result) ?? result.apply;
		applyMethods.set(result, apply);
		result.apply = function (target) {
			apply.call(this, target);
			if (target !== bot) return;
			clientControl ??= state.control;
			if (state.control !== clientControl) return;
			sequence++;
			for (const listener of [...listeners]) listener.after(sequence);
		};
		return result;
	};
	physics.simulatePlayer = wrapped;
	const clock: PhysicsSteps = {
		subscribe(before, after) {
			const item = { before, after };
			listeners.add(item);
			return () => {
				listeners.delete(item);
			};
		},
	};
	clocks.set(bot, clock);
	const end = () => {
		listeners.clear();
		if (physics.simulatePlayer === wrapped) physics.simulatePlayer = original;
		clocks.delete(bot);
		bot.removeListener("end", end);
	};
	bot.on("end", end);
	return clock;
}
