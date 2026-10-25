/** Last observed container contents, derived from the existing window evidence journal. */
import type { BlockTarget } from "../contracts/body.js";
import type { ClientFactsPort, ClientWindowObservation } from "../contracts/client-facts.js";
import { callFailure, type Fact, type JsonValue, type Observation, type Vec3 } from "../contracts/values.js";

export const CONTAINER_LAST_REF = "container.last@1";

export interface ContainerQueryParams {
	world: string;
	worldRevision: string;
	dimension: string;
	block: Vec3;
}

export interface ContainerEvidence {
	ref: string;
	fact: Fact<ClientWindowObservation>;
}

function object(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Only unqualified/current-relative coordinates require a live self; explicit dimensions work offline. */
export function resolveContainerQuery(
	input: JsonValue,
	binding: { world: string; worldRevision: string },
	facts: ClientFactsPort,
): ContainerQueryParams {
	// World has already validated the descriptor schema; only coordinate resolution belongs here.
	const { at } = input as unknown as { at: Vec3 | { rel: Vec3 } | { position: Vec3; dimension: string } };
	let block: Vec3;
	let dimension: string;
	if ("position" in at) {
		block = at.position;
		dimension = at.dimension;
	} else {
		const relative = "rel" in at;
		const self = facts.sample((view) => view.self()).value.value;
		if (self == null)
			throw callFailure({
				code: "WRONG_STATE",
				source: "world",
				message: "container.last needs current self to resolve unqualified or relative coordinates",
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		dimension = self.place.dimension;
		const point = "rel" in at ? at.rel : at;
		block = relative
			? {
					x: Math.floor(self.place.position.x) + point.x,
					y: Math.floor(self.place.position.y) + point.y,
					z: Math.floor(self.place.position.z) + point.z,
				}
			: point;
	}
	return { world: binding.world, worldRevision: binding.worldRevision, dimension, block };
}

export function containerObservation<T>(record: ContainerEvidence | null): Observation<T> {
	const observedAt = record?.fact.observedAt ?? new Date().toISOString();
	if (record == null)
		return {
			value: { found: false } as T,
			observedAt,
			source: "history",
			coverage: "complete",
			unknown: [],
			evidence: [],
			cursor: null,
		};
	const { target, snapshot } = record.fact.value;
	const blockTarget = target as BlockTarget;
	// 业务槽 = 除玩家区以外的区域：普通容器是 container，熔炉是 input/fuel/result。
	const regions = snapshot.layout.regions.filter((region) => region.name !== "player");
	const containerSlots = new Set(regions.flatMap((region) => region.slots));
	const slots = new Map(snapshot.slots.map((slot) => [slot.slot, slot.item]));
	const contents: { region: string | undefined; slot: number; name: string; count: number }[] = [];
	const counts: Record<string, number> = {};
	let complete = regions.length > 0;
	for (const slot of containerSlots) {
		if (!slots.has(slot)) {
			complete = false;
			continue;
		}
		const item = slots.get(slot);
		if (item == null) continue;
		if (!object(item) || typeof item.name !== "string" || !Number.isInteger(item.count) || Number(item.count) < 0) {
			complete = false;
			continue;
		}
		const count = Number(item.count);
		const region = regions.find((entry) => entry.slots.includes(slot));
		contents.push({ region: region?.name, slot, name: item.name, count });
		counts[item.name] = (counts[item.name] ?? 0) + count;
	}
	contents.sort((a, b) => a.slot - b.slot);
	return {
		value: {
			found: true,
			at: { position: blockTarget.block, dimension: blockTarget.place.dimension },
			type: snapshot.type,
			contents,
			counts,
			observedAt,
			source: "window",
			complete,
		} as T,
		observedAt,
		source: "history",
		coverage: complete ? "complete" : "partial",
		unknown: complete ? [] : ["last window observation does not cover every container slot"],
		evidence: [record.ref],
		cursor: null,
	};
}
