/**
 * ride@1 / lead@1（批 18）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 ride/lead、
 * development-plan.md §10.3 验收口径（上车/移动/下车、牵引/系绳/释放分别核验）。
 * 纪律（真服探针 2026-11-01）：
 * - 上车证据 = set_passengers/attach_entity（awaitBodyEvent 窗口）；mineflayer 对
 *   "空 passengers 下马"不发事件，所以一律走协议事实，不信 bot 事件。
 * - 1.21.2+ 非矿车载具全部客户端权威（vehicle_move 开环申报），且**骑乘态位移有服务端
 *   回声**（马的 rel_entity_move / 船的 sync_entity_position，mineflayer 会应用）——到达
 *   判定读载具实体位置即可信；已知缺口：Paper 1.21.11 忽略有鞍马的 vehicle_move，
 *   无鞍马的追踪方向不受申报控制（known-gaps 登记，验收如实断言 UNREACHABLE）。
 * - 牵引 = attach_entity（passengerId 归属目标）；释放 = 空手对目标 use_entity；
 *   系绳 = 手持拴绳对栅栏 interact，证据 = leash_knot 实体出现（独立事实复核）。
 */

import type { EntityRef, SelfState } from "../../contracts/body.js";
import { VEHICLE_KINEMATICS } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { FENCE_NAMES, isMountName, isSteerableMount } from "../shared/activity.js";
import { resolveEntity } from "../shared/entities.js";
import { readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach, ENTITY_REACH, round2 } from "../shared/reach.js";
import { POS_SCHEMA } from "../shared/schema.js";
import { assertSameDimension, distance, fail, resolvePoint } from "../shared/targets.js";
import { readInventory } from "../shared/views.js";

// ---- 共用小件 ----

function interrupted(progress: Record<string, unknown>): never {
	fail("INTERRUPTED", "the run was stopped or safety took over mid-action", {
		dispatch: "sent",
		progress,
		recoverable: true,
	});
}

function flatDistance(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

interface EntitiesView {
	entities: { ref: EntityRef; name: string; kind: string; position: Vec3; distance: number }[] | null;
}

async function readEntities(
	ctx: { world: CallContext["world"]; signal: AbortSignal },
	radius: number,
): Promise<NonNullable<EntitiesView["entities"]>> {
	const view = await readValue<EntitiesView>(
		ctx.world,
		"entities@1",
		{ radius, kind: "all", limit: 128 },
		ctx.signal,
		"entity search",
	);
	return view.entities ?? [];
}

/** drive 之后的载具读数：骑乘态客户端视图由服务端回声背书（探针 X4 实证：
 * 马的 rel_entity_move / 船的 sync_entity_position 都被 mineflayer 应用，与服务器真值
 * 吻合到 1e-7 量级）。返回 null = 载具已消失（服务端下车）。 */
async function trackedMountPosition(scope: BodyCallScope, mountId: number): Promise<Vec3 | null> {
	const entities = await readEntities(scope, 32);
	const mount = entities.find((entity) => entity.ref.networkId === mountId);
	return mount?.position ?? null;
}

// ---- ride@1 ----

const rideDescriptor: CallableDescriptor = {
	ref: "ride@1",
	summary:
		"Board the nearest mount (or a named one), optionally drive it toward `to`; `off:true` dismounts (after driving)",
	tags: ["body", "activity"],
	input: {
		type: "object",
		properties: {
			target: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
			to: POS_SCHEMA,
			off: { type: "boolean", description: "dismount instead of boarding" },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			riding: { type: "boolean" },
			mount: { type: "string" },
			at: { type: "object" },
		},
		required: ["riding", "at"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"riding=true means a set_passengers/attach fact named this client as a passenger; `at` after driving is the mount's tracked position (the mounted client view is backed by server echoes — rel_entity_move/sync_entity_position), so driving verifies arrival against real server-side movement",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no rideable mount within 16 blocks" },
		{ code: "UNREACHABLE", meaning: "mount out of interaction range, or the vehicle stopped short of `to`" },
		{
			code: "WRONG_STATE",
			meaning: "boarded nothing (untamed/no saddle), not mounted for `off`, or the mount cannot steer to `to`",
		},
		{ code: "INTERRUPTED", meaning: "stopped/safety mid-ride; mounted state is left as-is and reported in progress" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { target: "horse" },
			output: { riding: true, mount: "horse", at: { position: { x: 10, y: 64, z: 3 }, dimension: "overworld" } },
		},
	],
	implementation: "native",
};

interface RideInput {
	target?: string | EntityRef;
	to?: unknown;
	off?: boolean;
}

/** 到达容差：载具比步行惯性大，判得比 goto 松。 */
const DRIVE_ARRIVAL_TOLERANCE = 2.5;
/** 驾驶拍预算：速率取 contracts 唯一真源（船 0.22/拍、马/猪等 0.15/拍），封顶 30 秒。
 * 旧实现把马也按船速算预算，54 拍只够 8.1 格——马必停半路的确定性 bug（run9–13 根因之一）。 */
const BOAT_TICKS_PER_BLOCK = 1 / VEHICLE_KINEMATICS.boat.forward;
const MOUNT_TICKS_PER_BLOCK = 1 / VEHICLE_KINEMATICS.default.forward;
const DRIVE_MAX_TICKS = 600;

/** 驾驶失败前先下马：骑乘态 self 位置冻结，留在马上会让后续 goto 全部卡死。
 * shift 按住 500ms（10 拍）是真服实测的下马窗口——2 拍（100ms）不生效（探针 run13 教训）。 */
async function dismountQuietly(scope: BodyCallScope): Promise<void> {
	try {
		await scope.player.drive({ keys: { sneak: true } }, 10);
	} catch {
		// 下车失败不掩盖原失败；连接已亡时随连接消亡
	}
}

/** 驾驶到 to：预算按载具申报速率算，到达判定读载具实体位置（服务端回声背书，
 * 见 trackedMountPosition）。返回载具实测位置，供调用方作为 ride 的 `at` 结论。 */
async function driveToward(
	scope: BodyCallScope,
	mount: { ref: EntityRef; name: string; position: Vec3 },
	to: Vec3,
): Promise<{ at: Vec3 }> {
	if (!isSteerableMount(mount.name)) {
		// 矿车不可转向（协议窄口事实）：先下车再如实失败，不留"骑在车里动不了"的残留。
		await dismountQuietly(scope);
		fail("WRONG_STATE", `${mount.name} cannot steer; \`to\` is not drivable from a minecart`, {
			dispatch: "sent",
			hint: "minecarts only follow rails",
		});
	}
	// 矿车已在上面被 isSteerableMount 挡掉；能到这里的车全是 1.21.2+ 客户端权威载具。
	const ticksPerBlock =
		mount.name.includes("boat") || mount.name.includes("raft") ? BOAT_TICKS_PER_BLOCK : MOUNT_TICKS_PER_BLOCK;
	const gap = flatDistance(mount.position, to);
	const ticks = Math.min(DRIVE_MAX_TICKS, Math.max(20, Math.ceil((gap * ticksPerBlock) / 2) * 2));
	// 视角交给 drive 的载具分支：骑乘态不能走 body.lookAt（mineflayer lookAt 等物理
	// tick 收敛，mount 后物理停发会永久挂死——真服 60s 挂死实证），分支内直接算角度发原始包。
	const drive = await scope.player.drive({ keys: { forward: true }, lookAt: to }, ticks);
	const seen = await trackedMountPosition(scope, mount.ref.networkId);
	if (seen == null) {
		// 载具中途被杀/消失 = 服务端已下车，驾驶结论不成立（验收口径：载具消失有真实结论）。
		fail("WRONG_STATE", "mount vanished mid-drive (killed or despawned)", {
			dispatch: "sent",
			hint: "the server dismounted this client when the vehicle disappeared",
			progress: { mount: mount.name },
		});
	}
	const left = flatDistance(seen, to);
	if (left > DRIVE_ARRIVAL_TOLERANCE) {
		// 急停已由 drive 的退出路径保证（输入中和）；剩余距离如实上报（真服已测缺口：
		// Paper 1.21.11 忽略有鞍马的 vehicle_move，无鞍马追踪方向不受申报控制——见 known-gaps）。
		await dismountQuietly(scope);
		fail("UNREACHABLE", `vehicle stopped ${round2(left)} blocks short of \`to\``, {
			dispatch: "sent",
			hint: "obstruction between here and there; straight-line driving only — re-issue ride@1 to correct course",
			progress: { vehicleAt: seen, declaredAt: drive.vehicleAt ?? null, target: to },
		});
	}
	return { at: seen };
}

export function rideCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor: rideDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as RideInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const to = raw.to == null ? null : resolvePoint(raw.to, self);

			// ---- off：先（可选）驾驶，再下马 ----
			if (raw.off === true) {
				if (to != null) assertSameDimension(to, self, "ride destination");
				return await ctx.withBody(async (scope: BodyCallScope) => {
					// 证据窗口先于 sneak 派发打开：服务端的下马通知在驾驶拍进行中就会到达，
					// 后开窗会错过（真服船步实证）。不在车上时窗口走满后如实 WRONG_STATE。
					const pending = scope.player.awaitBodyEvent("dismount", { evidenceMs: 2500 });
					await scope.player.drive({ keys: { sneak: true } }, 10);
					const exit = await pending;
					if (exit.observed === null) interrupted({ phase: "dismount" });
					if (exit.observed !== true) {
						fail("WRONG_STATE", "no dismount evidence — not riding anything", {
							dispatch: "sent",
							hint: "ride@1 without `off` first; the sneak reached the server but nothing exited",
						});
					}
					const after = await readValue<SelfState>(scope.world, "self@1", {}, scope.signal, "self state");
					return plain({ riding: false, at: { position: after.place.position, dimension: after.place.dimension } });
				});
			}

			// ---- mount：选目标 → 距离前置 → 上车 →（可选）驾驶 ----
			let mount: { ref: EntityRef; name: string; position: Vec3; distance: number };
			if (raw.target != null) {
				const found = await resolveEntity(ctx.world, raw.target, 32);
				if (!isMountName(found.name)) {
					fail("WRONG_STATE", `${found.name} is not a rideable mount`, {
						hint: "rideable: boats, minecarts, horses/donkeys/mules, pig/strider/camel",
					});
				}
				mount = found;
			} else {
				const entities = await readEntities(ctx, 16);
				const mounts = entities.filter((entity) => isMountName(entity.name));
				if (mounts.length === 0) {
					fail("NOT_FOUND", "no rideable mount within 16 blocks", {
						hint: "boats/minecarts/horses/pigs count; anything beyond loaded range is invisible",
					});
				}
				mount = mounts.reduce((best, entity) => (entity.distance < best.distance ? entity : best));
			}
			if (mount.distance > ENTITY_REACH) {
				fail("UNREACHABLE", `mount is ${round2(mount.distance)} blocks away (> ${ENTITY_REACH})`, {
					hint: "goto@1 closer first; ride does not path",
				});
			}
			if (to != null) assertSameDimension(to, self, "ride destination");

			return await ctx.withBody(async (scope: BodyCallScope) => {
				// 上车证据窗口先于 interact 派发打开：set_passengers 在派发后毫秒级到达，
				// 后开窗会漏接（与 off:true 的下马竞态同构，真服实证）。
				const pending = scope.player.awaitBodyEvent("mount", { evidenceMs: 2500 });
				await scope.player.lookAt(mount.ref);
				await scope.player.interact({ target: mount.ref, hand: "main" });
				const boarded = await pending;
				if (boarded.observed === null) interrupted({ phase: "boarding" });
				if (boarded.observed !== true) {
					fail("WRONG_STATE", "mount interaction produced no boarding evidence", {
						dispatch: "sent",
						hint: "common causes: horse untamed or unsaddled, boat already occupied, pig/strider fine to board but not to steer",
					});
				}
				let at = mount.position;
				if (to != null) {
					at = (await driveToward(scope, mount, to.position)).at;
				}
				return plain({
					riding: true,
					mount: mount.name,
					at: { position: at, dimension: self.place.dimension },
				});
			});
		},
	};
}

// ---- lead@1 ----

const leadDescriptor: CallableDescriptor = {
	ref: "lead@1",
	summary: "Leash a mob (walk it to `to`, optionally tie to a fence) or release/tie-off with `release`/`tie`",
	tags: ["body", "activity"],
	input: {
		type: "object",
		properties: {
			target: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
			to: POS_SCHEMA,
			tie: { type: "boolean", description: "tie the leash to a nearby fence instead of holding it" },
			release: { type: "boolean", description: "detach the leash from the target" },
		},
		required: ["target"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			leashed: { type: "boolean" },
			at: { type: "object" },
		},
		required: ["leashed", "at"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"leashed=true is backed by an attach_entity fact for the target (holding or fence knot); release reports the detach fact — walking somewhere is never claimed as leashing",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "target entity not tracked nearby" },
		{ code: "MISSING_MATERIAL", meaning: "no lead in the inventory" },
		{ code: "UNREACHABLE", meaning: "target/fence out of range, mob left behind in transit, or no fence to tie to" },
		{
			code: "TARGET_NOT_MET",
			meaning: "the interaction reached the server but no leash evidence arrived in the window",
		},
		{ code: "INTERRUPTED", meaning: "stopped/safety mid-lead" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { target: "cow", to: { x: 12, y: 64, z: -4 } },
			output: { leashed: true, at: { position: { x: 12, y: 64, z: -3 }, dimension: "overworld" } },
		},
	],
	implementation: "native",
};

interface LeadInput {
	target: string | EntityRef;
	to?: unknown;
	tie?: boolean;
	release?: boolean;
}

/** 系绳/牵引搜索半径；拴绳 10 格断，超出即断。 */
const LEAD_SEARCH_RADIUS = 32;
const LEAD_TRANSIT_TOLERANCE = 4;
const LEAD_STRETCH_LIMIT = 10;

/** 到达后的链接复核：拴绳断了/目标丢失都算 UNREACHABLE，不假装牵到位。 */
async function assertStillLeashed(
	world: CallContext["world"],
	signal: AbortSignal,
	targetId: number,
	to: Vec3,
): Promise<{ position: Vec3 }> {
	// 牛的跟随 AI 滞后于玩家（k8 实证：玩家到位时牛常落在 4~5 格外）：
	// 给 6 秒让牛跟上来，进容差即通过；真丢了/超时才如实 UNREACHABLE。
	const deadline = Date.now() + 6000;
	for (;;) {
		const entities = await readEntities({ world, signal }, LEAD_SEARCH_RADIUS);
		const mob = entities.find((entity) => entity.ref.networkId === targetId);
		if (mob == null) {
			fail("UNREACHABLE", "the leashed mob is no longer tracked — the leash broke in transit", {
				dispatch: "sent",
				hint: "a broken leash drops the lead; re-leash and retry",
			});
		}
		if (flatDistance(mob.position, to) <= LEAD_TRANSIT_TOLERANCE) return mob;
		if (Date.now() >= deadline) {
			fail(
				"UNREACHABLE",
				`the mob is ${round2(flatDistance(mob.position, to))} blocks from \`to\` after 6s (leash stretch limit ${LEAD_STRETCH_LIMIT})`,
				{
					dispatch: "sent",
					hint: "it lagged behind; walk back toward it and retry",
					progress: { mobAt: mob.position, target: to },
				},
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

export function leadCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor: leadDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as LeadInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const target = await resolveEntity(ctx.world, raw.target, LEAD_SEARCH_RADIUS);
			if (target.distance > ENTITY_REACH) {
				fail("UNREACHABLE", `target is ${round2(target.distance)} blocks away (> ${ENTITY_REACH})`, {
					hint: "goto@1 closer first; lead does not path before leashing",
				});
			}
			const to = raw.to == null ? null : resolvePoint(raw.to, self);
			if (to != null) assertSameDimension(to, self, "lead destination");

			// ---- release：空手对目标 use_entity（探针实证），证据 = 解除链接 ----
			if (raw.release === true) {
				return await ctx.withBody(async (scope: BodyCallScope) => {
					// 已空手就不再点击（手持槽自换会产生不可确认的窗口点击，真服实证）。
					if ((await readInventory(scope.world)).held != null) {
						await scope.player.equip(null, "hand");
					}
					// 解除证据窗口先于 interact 派发打开（attach_entity 毫秒级到达，后开窗漏接）。
					const pending = scope.player.awaitBodyEvent("link", {
						passengerId: target.ref.networkId,
						detached: true,
						evidenceMs: 2500,
					});
					await scope.player.interact({ target: target.ref, hand: "main" });
					const detached = await pending;
					if (detached.observed === null) interrupted({ phase: "release" });
					if (detached.observed !== true) {
						fail("TARGET_NOT_MET", "no release evidence — the target was not leashed (or not to this client)", {
							dispatch: "sent",
							hint: "re-read the target; a leash tied to a fence is released at the knot, not the mob",
						});
					}
					return plain({ leashed: false, at: { position: target.position, dimension: self.place.dimension } });
				});
			}

			// ---- leash：拴绳前置 → 对目标 use_entity → attach_entity 证据 ----
			const inventory = await readInventory(ctx.world);
			if ((inventory.counts["lead"] ?? 0) <= 0) {
				fail("MISSING_MATERIAL", "no lead in the inventory");
			}
			const linked = await ctx.withBody(async (scope: BodyCallScope) => {
				// 已手持拴绳就不再点击（手持槽自换会产生不可确认的窗口点击，真服实证）。
				if ((await readInventory(scope.world)).held?.name !== "lead") {
					await scope.player.equip({ name: "lead" }, "hand");
				}
				// 已拴在本玩家就不再点击（批 18 真服实证）：对已拴目标 use_entity = 解除，
				// "先拴后牵"两连调会让第二次调用把第一次的绳解掉；本连接事实缓存兜底。
				if (await scope.player.leashedBySelf(target.ref)) return true;
				// 链接证据窗口先于 interact 派发打开（attach_entity 毫秒级到达，后开窗漏接）。
				const pending = scope.player.awaitBodyEvent("link", {
					passengerId: target.ref.networkId,
					evidenceMs: 2500,
				});
				await scope.player.lookAt(target.ref);
				await scope.player.interact({ target: target.ref, hand: "main" });
				const outcome = await pending;
				if (outcome.observed === null) interrupted({ phase: "leashing" });
				return outcome.observed;
			});
			if (linked !== true) {
				fail("TARGET_NOT_MET", "leash interaction produced no link evidence", {
					dispatch: "sent",
					hint: "common causes: target already leashed elsewhere, or it moved out of range mid-interaction",
				});
			}
			// 行程在身体作用域外走：Body 槽与 goto 槽互斥（carrying 同款纪律）；
			// 牛跟人走，到达后独立复核链接与位置。
			let mobEnd = target.position;
			if (to != null) {
				await ctx.call("goto@1", { at: to.position, tolerance: 1, maxTimeMs: 60_000 });
				const mob = await assertStillLeashed(ctx.world, ctx.signal, target.ref.networkId, to.position);
				mobEnd = mob.position;
			}
			if (raw.tie === true) {
				const knot = await ctx.withBody(async (scope: BodyCallScope) => tieToFence(scope, ctx, mobEnd));
				if (knot == null) {
					fail("UNREACHABLE", "no fence within reach to tie the leash to", {
						dispatch: "sent",
						hint: "place a fence near the destination first; walls and fence gates do not take knots",
					});
				}
				return plain({ leashed: true, at: { position: knot, dimension: self.place.dimension } });
			}
			return plain({ leashed: true, at: { position: mobEnd, dimension: self.place.dimension } });
		},
	};
}

/** 手持拴绳对栅栏 interact，证据 = leash_knot 实体出现在栅栏旁（独立事实复核）。 */
async function tieToFence(scope: BodyCallScope, ctx: CallContext, mobAt: Vec3): Promise<Vec3 | null> {
	const searches = await Promise.all(
		FENCE_NAMES.map(async (name) => {
			const view = await readValue<{ blocks: { position: Vec3; name: string }[] | null }>(
				ctx.world,
				"blocks@1",
				{ name, radius: 8, limit: 8 },
				ctx.signal,
				"fence search",
			);
			return view.blocks ?? [];
		}),
	);
	let fence: { position: Vec3; name: string } | null = null;
	for (const matches of searches) {
		for (const match of matches) {
			if (fence == null || flatDistance(mobAt, match.position) < flatDistance(mobAt, fence.position)) fence = match;
		}
	}
	if (fence == null) return null;
	const self = await readValue<SelfState>(scope.world, "self@1", {}, scope.signal, "self state");
	if (blockReach(self, fence.position) > BLOCK_REACH) return null;
	// 空手点栅栏（探针实证：拴绳已被拴牛挂走，手持物品反而会触发放置）；
	// 已空手就不再点击（手持槽自换会产生不可确认的窗口点击，真服实证）。
	if ((await readInventory(scope.world)).held != null) {
		await scope.player.equip(null, "hand");
	}
	await scope.player.interact({
		target: { place: self.place, block: fence.position },
		hand: "main",
	});
	// leash_knot 是真实实体：短窗轮询独立复核，不靠 interact 回执。
	const deadline = Date.now() + 3000;
	for (;;) {
		if (scope.signal.aborted) return null;
		const entities = await readEntities(scope, 16);
		const knot = entities.find(
			(entity) => entity.name === "leash_knot" && distance(entity.position, fence.position) <= 1.5,
		);
		if (knot != null) return knot.position;
		if (Date.now() >= deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
