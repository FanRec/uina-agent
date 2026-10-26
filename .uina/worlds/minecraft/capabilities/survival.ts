/** Local preservation policy; Runtime owns qualification and records. */
import type { BodySession, SelfState, ControlInput } from "../contracts/body.js";
import type { ClientFactsPort } from "../contracts/client-facts.js";
import type { SafetyInterventionRecord } from "../contracts/runtime.js";
import type { Fact, Ref, Vec3 } from "../contracts/values.js";
import type { WorldPort } from "../contracts/world.js";
import type { SafetyTrigger, SafetyWork } from "../runtime/safety.js";

type Hazard = SafetyTrigger["kind"];
export function nextEscapeWaypoint(route: Vec3[], p: Vec3): Vec3 | undefined {
	while (route.length && Math.hypot(route[0]!.x - p.x, route[0]!.z - p.z) < 0.15 && Math.abs(route[0]!.y - p.y) < 0.25)
		route.shift();
	return route[0];
}
export function escapeInput(self: SelfState, target: Vec3 | undefined): ControlInput {
	const p = self.place.position;
	return {
		keys: target
			? {
					forward: Math.hypot(target.x - p.x, target.z - p.z) > 0.05,
					jump: target.y > p.y + 0.1 || self.inWater === true || self.inLava === true,
					sprint: self.inWater !== true && self.inLava !== true,
				}
			: {},
		...(target ? { lookAt: { ...target, y: target.y + 1.62 } } : {}),
	};
}
export function survivalTrigger(self: SelfState, lastDamage: number | null, now: number): Hazard | null {
	if (self.health !== null && self.health <= 0) return null;
	if (self.inLava === true) return "lava";
	if (
		self.inWater === true &&
		self.oxygen !== null &&
		self.oxygen <= 4 &&
		self.effects !== null &&
		!self.effects.some((e) => ["water_breathing", "conduit_power"].includes(e.name))
	)
		return "drowning";
	if (
		self.health !== null &&
		self.maxHealth !== null &&
		self.health <= self.maxHealth * 0.3 &&
		lastDamage !== null &&
		now - lastDamage <= 2000
	)
		return "low_health_damage";
	return null;
}
interface Dependencies {
	facts: ClientFactsPort;
	world: WorldPort;
	runtime: {
		assertActionAllowed(): void;
		intervene(trigger: SafetyTrigger, work: SafetyWork): Promise<SafetyInterventionRecord>;
	};
	plan(kind: Hazard, threats: Vec3[], signal: AbortSignal): Promise<Vec3[] | null>;
	breathable(self: SelfState): boolean | null;
	onFault(error: unknown): void;
}
export function startSurvival(deps: Dependencies) {
	let closed = false,
		running: Promise<unknown> | null = null,
		lastDamage: number | null = null,
		damage: Ref | null = null;
	let latched: string | null = null;
	const sample = (): Fact<SelfState> | null => {
		const fact = deps.facts.sample((view) => view.self()).value;
		return fact.value ? { ...fact, value: fact.value } : null;
	};
	async function work(kind: Hazard, body: BodySession, signal: AbortSignal) {
		const stream = await body.feedback({});
		let after: number | null = null,
			route: Vec3[] | null = null,
			lastPlan = 0;
		const initialOxygen = sample()?.value.oxygen ?? 0;
		try {
			while (true) {
				const frame = await stream.next(after, signal);
				after = frame.sequence;
				const self = frame.self.value;
				if (self.health === 0) return "invalidated" as const;
				const now = performance.now();
				const threats =
					kind === "low_health_damage"
						? (
								await deps.world.read<{ entities: { position: Vec3 }[] }>({
									ref: "entities@1",
									input: { kind: "hostile", radius: 16 },
								})
							).value.entities.map((e) => e.position)
						: [];
				if (kind === "lava" && self.inLava === false && self.onGround) return "safe" as const;
				if (
					kind === "drowning" &&
					deps.breathable(self) === true &&
					self.oxygen !== null &&
					self.oxygen > initialOxygen
				)
					return "safe" as const;
				if (
					kind === "low_health_damage" &&
					threats.every(
						(t) =>
							Math.hypot(t.x - self.place.position.x, t.y - self.place.position.y, t.z - self.place.position.z) >= 8,
					) &&
					lastDamage !== null &&
					now - lastDamage >= 2000 &&
					self.onGround
				)
					return "safe" as const;
				if (route === null || now - lastPlan > 1000) {
					route = await deps.plan(kind, threats, signal);
					lastPlan = performance.now();
					if (route === null) return "blocked" as const;
				}
				const p = self.place.position;
				const target = nextEscapeWaypoint(route, p);
				try {
					await stream.apply(frame, escapeInput(self, target));
				} catch (error) {
					if ((error as { code?: string }).code !== "FRAME_EXPIRED") throw error;
				}
				if (!target) route = null;
			}
		} finally {
			await stream.close();
		}
	}
	const check = () => {
		if (closed) return;
		try {
			const fact = sample();
			if (!fact) return;
			const kind = survivalTrigger(fact.value, lastDamage, performance.now());
			if (!kind) {
				latched = null;
				return;
			}
			const key = `${fact.connection}:${fact.incarnation}:${kind}:${kind === "low_health_damage" ? damage : ""}`;
			if (running || latched === key) return;
			deps.runtime.assertActionAllowed();
			latched = key;
			const trigger: SafetyTrigger = {
				kind,
				sample: fact,
				evidence: damage && kind === "low_health_damage" ? [damage] : [],
			};
			running = deps.runtime
				.intervene(trigger, (body, signal) => work(kind, body, signal))
				.catch(deps.onFault)
				.finally(() => {
					running = null;
				});
		} catch {
			/* gates and unsynchronized sources forbid intervention */
		}
	};
	const subscription = deps.facts.subscribe((notice) => {
		if (notice.kind === "evidence")
			for (const record of notice.records)
				if ((record.fact.value as { kind?: string })?.kind === "damage") {
					lastDamage = performance.now();
					damage = record.ref;
				}
		if (notice.kind === "reset") {
			lastDamage = null;
			damage = null;
			latched = null;
		}
		check();
	});
	return {
		async close() {
			closed = true;
			subscription.close();
			await running;
		},
	};
}
