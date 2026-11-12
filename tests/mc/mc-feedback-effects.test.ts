import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import { makeBodyHarness, openSignal, ownerT, placeT } from "./mc-fake-driver.js";

function fixture(failAttack = false, waitForLook = false) {
	const events = new EventEmitter();
	let attacks = 0;
	let looks = 0;
	let releaseLook = () => {};
	const control = {};
	const physics = {
		simulatePlayer(state: { control: object; apply(bot: unknown): void }) {
			return state;
		},
	};
	const h = makeBodyHarness(
		{
			on: events.on.bind(events),
			removeListener: events.removeListener.bind(events),
			entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
			entities: { 42: { id: 42, position: { x: 1, y: 64, z: 0 } } },
			game: { dimension: "overworld" },
			physics,
			setControlState: () => {},
			look: async () => {},
			lookAt: async () => {
				looks++;
				if (waitForLook)
					await new Promise<void>((resolve) => {
						releaseLook = resolve;
					});
			},
			blockAt: () => null,
			attack: () => {
				attacks++;
				if (failAttack) throw new Error("dispatch acknowledgement lost");
			},
		},
		{ prepareFeedback: () => () => ({ self: { value: { health: 20 } as SelfState } as Fact<SelfState>, sensors: {} }) },
	);
	return {
		h,
		attacks: () => attacks,
		looks: () => looks,
		releaseLook: () => releaseLook(),
		step: () => physics.simulatePlayer({ control, apply() {} }).apply(h.bot),
	};
}
const target = { connection: "conn:t1", incarnation: "inc:t1", appearance: "ap:42", networkId: 42 };
test("stale look reference is rejected before the attack in a mixed input", async () => {
	const f = fixture();
	const body = await f.h.port.acquire(ownerT(1), openSignal());
	const stream = await body.feedback({});
	f.step();
	const frame = await stream.next(null, openSignal());
	const pending = expect(
		stream.apply(frame, {
			keys: {},
			attack: target,
			lookAt: { dimension: "the_nether", position: { x: 1, y: 64, z: 0 } },
		}),
	).rejects.toMatchObject({ code: "REFERENCE_STALE", dispatch: "not_sent" });
	f.step();
	await pending;
	expect(f.attacks()).toBe(0);
	expect(f.h.facts).toHaveLength(0);
	await stream.close();
	await body.close();
});
test("a possibly dispatched attack keeps its effect and unknown failure", async () => {
	const f = fixture(true);
	const body = await f.h.port.acquire(ownerT(1), openSignal());
	const stream = await body.feedback({});
	f.step();
	const frame = await stream.next(null, openSignal());
	const pending = expect(stream.apply(frame, { keys: {}, attack: target })).rejects.toMatchObject({
		dispatch: "unknown",
		effects: expect.arrayContaining([expect.any(String)]),
	});
	f.step();
	await pending;
	expect(f.attacks()).toBe(1);
	expect(f.h.facts[0]).toMatchObject({ contract: "body.feedback@1", dispatch: "unknown", completion: "unknown" });
	await body.close();
});

test("pending and installed feedback view reject discrete view writers until a keys-only frame releases it", async () => {
	const f = fixture();
	const body = await f.h.port.acquire(ownerT(1), openSignal());
	const stream = await body.feedback({});
	try {
		f.step();
		const frame = await stream.next(null, openSignal());
		const application = stream.apply(frame, { keys: {}, look: { yaw: 1, pitch: 0 } });
		const rejected = expect(body.lookAt({ x: 1, y: 64, z: 0 })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
			dispatch: "not_sent",
		});
		f.step();
		await application;
		await rejected;
		const block = { place: placeT(), block: { x: 1, y: 64, z: 0 } };
		await expect(body.dig(block)).rejects.toMatchObject({ code: "CONTROL_CONFLICT", dispatch: "not_sent" });
		await expect(body.openContainer(block)).rejects.toMatchObject({ code: "CONTROL_CONFLICT", dispatch: "not_sent" });
		await expect(body.interact({ target: block, hand: "main" })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
			dispatch: "not_sent",
		});
		await expect(body.writeSign(block, { side: "front", lines: ["", "", "", ""] })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
			dispatch: "not_sent",
		});
		await expect(body.dig(block, { aim: "preserve" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(f.looks()).toBe(0);
		const next = await stream.next(frame.sequence, openSignal());
		const released = stream.apply(next, { keys: { forward: true } });
		f.step();
		await released;
		await expect(body.lookAt({ x: 1, y: 64, z: 0 })).resolves.toMatchObject({ completion: "met" });
		expect(f.looks()).toBe(1);
		// 视角操作的完成合同由 Driver 当场断言，必须记 receipt。只记 dispatch 会被统一判定
		// 读成"已派发、无结论"，父调用交付时把每次转头都判成 EFFECT_UNCONFIRMED。
		expect(f.h.facts.at(-1)).toMatchObject({
			contract: "body.lookAt@1",
			kind: "receipt",
			dispatch: "sent",
			completion: "met",
		});
	} finally {
		await body.close();
	}
});

test("feedback-held view rejects a target-aimed dig but preserve proceeds without taking the view", async () => {
	const f = fixture();
	const body = await f.h.port.acquire(ownerT(1), openSignal());
	const stream = await body.feedback({});
	f.step();
	const frame = await stream.next(null, openSignal());
	const applied = stream.apply(frame, { keys: {}, look: { yaw: 1, pitch: 0 } });
	f.step();
	await applied;
	const block = { place: placeT(), block: { x: 1, y: 64, z: 0 } };
	// 反馈流持有视角：默认挖掘按 CONTROL_CONFLICT 拒绝，不暗中覆盖战斗视角。
	await expect(body.dig(block)).rejects.toMatchObject({ code: "CONTROL_CONFLICT", dispatch: "not_sent" });
	// preserve 不申请视角：走到世界检查（夹具里该格未加载 → NOT_FOUND），不是 CONTROL_CONFLICT。
	await expect(body.dig(block, { aim: "preserve" })).rejects.toMatchObject({ code: "NOT_FOUND", dispatch: "not_sent" });
	expect(f.looks()).toBe(0);
	await body.close();
});

test("a discrete look in flight rejects feedback view while keys-only feedback remains usable", async () => {
	const f = fixture(false, true);
	const body = await f.h.port.acquire(ownerT(1), openSignal());
	const stream = await body.feedback({});
	const look = body.lookAt({ x: 1, y: 64, z: 0 });
	try {
		f.step();
		const frame = await stream.next(null, openSignal());
		const rejected = expect(stream.apply(frame, { keys: {}, look: { yaw: 1, pitch: 0 } })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
			dispatch: "not_sent",
		});
		f.step();
		await rejected;
		const keys = stream.apply(frame, { keys: { forward: true } });
		f.step();
		await keys;
		f.releaseLook();
		await look;
		const next = await stream.next(frame.sequence, openSignal());
		const view = stream.apply(next, { keys: {}, look: { yaw: 1, pitch: 0 } });
		f.step();
		await view;
	} finally {
		f.releaseLook();
		await look;
		await body.close();
	}
});
