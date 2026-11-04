/**
 * 载具驾驶（批 18 引入，批 24 从 BodySession 分离）：运动学递推 + 固定节拍申报。
 *
 * 职责边界：这里只拥有"骑乘态怎么开"——客户端权威运动学、50ms 节拍包序、
 * 输入中和。资格、撤销屏障与效果归属仍归 BodySession（signal/recorder 由
 * 调用方传入，记录的合同名不变）。版本差异（vehicle_move 字段、player_input
 * 通道）只经 DriverProtocol，不在此对版本字符串分支。
 * 已知缺口 G23：Paper 忽略有鞍马的 vehicle_move 申报。
 */

import type { ControlInput, EntityRef, PointTarget, SelfState } from "../../contracts/body.js";
import { isClientAuthVehicle, VEHICLE_KINEMATICS } from "../../contracts/body.js";
import type { EffectReceipt, Fact, JsonValue, Ref, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { EffectRecorder } from "../execution.js";
import { fail } from "../execution.js";
import { type MineflayerBot } from "../mineflayer/adapter.js";
import { protocolFor } from "../mineflayer/protocol.js";

/** 载具分支（批 18）：mineflayer mount 后 physicsTick 停发，载具拍用固定 50ms 节拍。 */
const VEHICLE_TICK_MS = 50;
/** 载具转向速率（弧度/拍）：开环递推的航向修正，探针实测被服务端接受。 */
const BOAT_TURN_RATE = 0.04;

/** BodySession 注入的窄依赖：撤销信号、效果记录、自采样与共用目标解析。 */
export interface VehicleDriveDeps {
	/** 会话撤销信号：中止即如实 INTERRUPTED（actualTicks 保留）。 */
	signal: AbortSignal;
	/** scope 感知的效果记录（drive 在 ALS 作用域内调用时即该 scope 的 recorder）。 */
	recorder: EffectRecorder;
	/** 组合根注入的自采样（与 BodySession 共用同一事实源）。 */
	sampleSelf: () => Fact<SelfState | null> | null;
	/** lookAt 目标解析（identity 感知），复用 BodySession 的共用实现。 */
	resolveLookTarget(bot: MineflayerBot, target: PointTarget | EntityRef): Vec3;
}

/**
 * 载具驾驶：固定 50ms 节拍逐拍派发，任何退出路径由调用方中和输入。
 * 1.21.2+ 全部非矿车载具客户端权威：运动学递推位置 + 每拍 vehicle_move；
 * 视角在分支内按角度直算发原始包，不走 bot.lookAt（骑乘态 physicsTick 停发会永久挂死）。
 */
export async function driveVehicle(
	deps: VehicleDriveDeps,
	bot: MineflayerBot,
	input: ControlInput,
	ticks: number,
	eff: Ref,
	op: Ref,
): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState>; vehicleAt: Vec3 }> {
	const vehicle = bot.vehicle;
	const vehicleName = vehicle?.name ?? "";
	const clientAuth = isClientAuthVehicle(vehicleName);
	const wantsMovement =
		input.keys.forward === true || input.keys.back === true || input.keys.left === true || input.keys.right === true;
	if (!clientAuth && wantsMovement) {
		// 矿车是轨道驱动：驾驶请求如实失败（capability 层先挡，这里是协议窄口的第二道）；
		// 但 sneak-only 放行——它是下马原语，矿车也靠它下车（批 18 真服实证）。
		throw fail({
			code: "WRONG_STATE",
			source: "input",
			message: `${vehicleName} follows rails and takes no drive input`,
			dispatch: "not_sent",
			recoverable: true,
		});
	}
	// 运动学以载具实体位置为起点（骑乘态客户端视图冻结：self 与被骑载具都不回同步）。
	// 速率取 contracts 唯一真源：船 0.22/拍，马/猪等 0.15/拍（探针实测被服务端接受）。
	const isBoat = vehicleName.includes("boat") || vehicleName.includes("raft");
	const rates = isBoat ? VEHICLE_KINEMATICS.boat : VEHICLE_KINEMATICS.default;
	const kinematics = {
		x: vehicle?.position.x ?? bot.entity.position.x,
		y: vehicle?.position.y ?? bot.entity.position.y,
		z: vehicle?.position.z ?? bot.entity.position.z,
		yaw: bot.entity.yaw,
		pitch: bot.entity.pitch,
		speed: 0,
		forwardRate: rates.forward,
		reverseRate: rates.reverse,
	};
	// 视角：按角度直算进运动学（mineflayer lookAt 等物理 tick 收敛，骑乘态会永久挂死）。
	if (input.lookAt != null) {
		const point = deps.resolveLookTarget(bot, input.lookAt);
		const eye = { x: kinematics.x, y: kinematics.y + 1.2, z: kinematics.z };
		const dx = point.x - eye.x;
		const dy = point.y - eye.y;
		const dz = point.z - eye.z;
		kinematics.yaw = Math.atan2(-dx, dz);
		kinematics.pitch = Math.atan2(-dy, Math.hypot(dx, dz));
	} else if (input.look != null) {
		kinematics.yaw = input.look.yaw;
		kinematics.pitch = input.look.pitch;
	}
	deps.recorder.record(
		eff,
		op,
		"body.drive@1",
		"dispatch",
		"sent",
		"unknown",
		plain({
			keys: { ...input.keys },
			look: input.look ?? null,
			lookAt: input.lookAt == null ? null : ({ ...input.lookAt } as unknown as JsonValue),
			vehicle: { name: vehicleName, clientAuth },
			kind: "vehicle",
		}),
	);
	const consumed = await consumeVehicleTicks(bot, input, kinematics, ticks, eff, deps.signal);
	// 骑乘态 self 视图冻结，申报终点只作审计对照；载具本体有服务端回声
	// （rel_entity_move/sync_entity_position），到达判定由调用方读载具实体位置。
	const vehicleAt: Vec3 = { x: kinematics.x, y: kinematics.y, z: kinematics.z };
	const sampled = deps.sampleSelf();
	if (sampled == null || sampled.value == null) {
		throw fail({
			code: "INTERNAL",
			source: "capability",
			message: "self sampling unavailable after vehicle drive; inputs were applied",
			dispatch: "sent",
			progress: { actualTicks: consumed, vehicle: vehicleName },
			effects: [eff],
			recoverable: false,
		});
	}
	const end: Fact<SelfState> = { ...sampled, value: sampled.value };
	deps.recorder.record(eff, op, "body.drive@1", "receipt", "sent", "met", {
		actualTicks: consumed,
		vehicle: vehicleName,
		vehicleAt: plain(vehicleAt),
		completionContract:
			"vehicle inputs applied for the requested 50ms ticks; the declared endpoint is the open-loop proposal, not a server-confirmed position",
	});
	return {
		receipt: { effect: eff, dispatch: "sent", completion: "met", evidence: [] },
		actualTicks: consumed,
		end,
		vehicleAt,
	};
}

/** 载具拍消费：固定节拍；中止/断线如实 INTERRUPTED（actualTicks 保留）。 */
function consumeVehicleTicks(
	bot: MineflayerBot,
	input: ControlInput,
	kinematics: {
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
		speed: number;
		forwardRate: number;
		reverseRate: number;
	},
	ticks: number,
	eff: Ref,
	signal: AbortSignal,
): Promise<number> {
	const keys = input.keys;
	const protocol = protocolFor(bot);
	return new Promise<number>((resolve, reject) => {
		let consumed = 0;
		let settled = false;
		const cleanup = (): void => {
			clearInterval(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const onAbort = (): void => {
			settle(() =>
				reject(
					fail({
						code: "INTERRUPTED",
						source: "environment",
						message: "vehicle drive interrupted; inputs neutralized",
						dispatch: "sent",
						progress: { actualTicks: consumed },
						effects: [eff],
						recoverable: true,
					}),
				),
			);
		};
		const timer = setInterval(() => {
			consumed++;
			// 回调内任何异常都必须 settle：setInterval 里抛错会让本 promise 永不结束，
			// 身体槽被占死（真服 60s 挂死 + CONTROL_ISOLATION_FAILED 连锁的教训）。
			try {
				// 1.21.2+ 载具移动全面客户端权威（真服探针实测）：马对 player_input 的
				// forward 无响应；vehicle_move 生效但服务端带自己的物理拉扯，且**同一拍
				// 里发 player_input 会以输入位压制位移**（forward:false + 位置变更 = 拒收）。
				// 因此移动拍只发 vehicle_move（服务端回传位姿做闭环起点，沿 yaw 推进）；
				// 非移动拍（sneak 下马 / jump）只发 player_input，不掺 vehicle_move。
				const movement = keys.forward === true || keys.back === true || keys.left === true || keys.right === true;
				if (movement) {
					if (keys.left === true) kinematics.yaw += BOAT_TURN_RATE;
					if (keys.right === true) kinematics.yaw -= BOAT_TURN_RATE;
					kinematics.speed =
						keys.forward === true ? kinematics.forwardRate : keys.back === true ? -kinematics.reverseRate : 0;
					// 开环递推（探针验证）：申报点必须持续前移，马才会追踪；
					// 不能用服务端回读位置做闭环起点——被拒后回读不动，申报点冻结在原地，死锁。
					kinematics.x += -Math.sin(kinematics.yaw) * kinematics.speed;
					kinematics.z += Math.cos(kinematics.yaw) * kinematics.speed;
					protocol.vehicleMove({ x: kinematics.x, y: kinematics.y, z: kinematics.z }, kinematics.yaw);
				} else {
					protocol.vehicleInput({
						forward: false,
						backward: false,
						left: false,
						right: false,
						jump: keys.jump === true,
						shift: keys.sneak === true,
						sprint: keys.sprint === true,
					});
				}
				if (consumed >= ticks) settle(() => resolve(consumed));
			} catch (err) {
				settle(() =>
					reject(
						fail({
							code: "INTERNAL",
							source: "environment",
							message: `vehicle input write failed: ${String(err)}`,
							dispatch: "sent",
							progress: { actualTicks: consumed, vehicle: bot.vehicle?.name ?? "" },
							effects: [eff],
							recoverable: true,
						}),
					),
				);
			}
		}, VEHICLE_TICK_MS);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** 载具输入中和：退出路径统一调用（防止"下车后还在按 W"与马持续前行）。 */
export function neutralizeVehicle(bot: MineflayerBot): void {
	// 非骑乘不发：player_input 是载具键位通道（1.21.2+），步行撤销发它纯属多余。
	if (bot.vehicle == null) return;
	try {
		protocolFor(bot).vehicleInput({});
	} catch {
		// 客户端消亡时输入随连接消亡
	}
}
