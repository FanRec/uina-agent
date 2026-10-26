import { expect, test } from "vitest";
import {
	survivalTrigger,
	nextEscapeWaypoint,
	escapeInput,
} from "../../.uina/worlds/minecraft/capabilities/survival.js";
import type { SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import {
	escapeWaypoints,
	escapeGoalBias,
	escapeThreatClearance,
} from "../../.uina/worlds/minecraft/driver/mineflayer/pathfinder.js";

test("only observed hazards trigger preservation; low health alone and unknown immunity do not", () => {
	const self = {
		health: 6,
		maxHealth: 20,
		inLava: false,
		inWater: false,
		oxygen: null,
		effects: [],
	} as unknown as SelfState;
	expect(survivalTrigger(self, null, 1000)).toBeNull();
	expect(survivalTrigger(self, 500, 1000)).toBe("low_health_damage");
	expect(survivalTrigger(self, 0, 3000)).toBeNull();
	expect(survivalTrigger({ ...self, inWater: true, oxygen: 4 }, null, 1000)).toBe("drowning");
	expect(survivalTrigger({ ...self, inWater: true, oxygen: 4, effects: null }, null, 1000)).toBeNull();
	expect(
		survivalTrigger(
			{ ...self, inWater: true, oxygen: 4, effects: [{ name: "water_breathing", amplifier: 0, seconds: 1 }] },
			null,
			1000,
		),
	).toBeNull();
	expect(survivalTrigger({ ...self, inLava: true }, null, 1000)).toBe("lava");
	expect(survivalTrigger({ ...self, health: null, inLava: true }, null, 1000)).toBe("lava");
	expect(survivalTrigger({ ...self, health: 0, inLava: true }, null, 1000)).toBeNull();
});

test("escape keeps moving until the body is clear of the adjacent lava cell", () => {
	const route = [{ x: 16009.5, y: 200, z: 16000.5 }];
	expect(nextEscapeWaypoint(route, { x: 16009.806, y: 200, z: 16000.5 })).toEqual(route[0]);
	expect(nextEscapeWaypoint(route, { x: 16009.6, y: 200, z: 16000.5 })).toBeUndefined();
});

test("empty node path still centers the body when its trailing edge touches lava", () => {
	expect(escapeWaypoints([], { x: 16027.069, y: 200, z: 16000.5 })).toEqual([{ x: 16027.5, y: 200, z: 16000.5 }]);
});

test("escape does not brake in the gap between steering and waypoint arrival tolerances", () => {
	const self = { place: { position: { x: 16009.67, y: 200, z: 16000.5 } }, inLava: true } as SelfState;
	expect(escapeInput(self, { x: 16009.5, y: 200, z: 16000.5 }).keys.forward).toBe(true);
});

test("equidistant grid exits prefer the closer side of the actual moving body", () => {
	const position = { x: 16026.808, y: 200, z: 16000.5 };
	expect(escapeGoalBias({ x: 16027, y: 200, z: 16000 }, position)).toBeLessThan(
		escapeGoalBias({ x: 16025, y: 200, z: 16000 }, position),
	);
});

test("threat goal includes the waypoint center and arrival tolerance", () => {
	const threats = [{ x: 16014.5, y: 200, z: 16000.5 }];
	expect(escapeThreatClearance({ x: 16006, y: 200, z: 16000 }, threats)).toBe(false);
	expect(escapeThreatClearance({ x: 16005, y: 200, z: 16000 }, threats)).toBe(true);
});
