import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, keys, offset, timeline, track, type TimeSpan } from "../../../authoring/curves.js";

/** 放松看镜头；偶尔偷瞄、歪头、浅笑，事件间保留安静期。所有随机量仅在 Bake 时抽取。 */
export const cuteIdle: ActionAuthoring = (rng) => {
	const between = (min: number, max: number): number => min + (max - min) * rng();
	const side = rng() < 0.5 ? -1 : 1;
	const peekStart = between(5000, 5300);
	const tiltStart = between(15000, 15300);
	const smileStart = between(25000, 25200);
	const time = timeline(32000, {
		peekStart,
		peekEnd: peekStart + between(3200, 3600),
		tiltStart,
		tiltEnd: tiltStart + between(4000, 4500),
		smileStart,
		smileEnd: smileStart + between(2500, 2800),
	});
	const whole = time.span("start", "end");
	const events = [
		{ span: time.span("peekStart", "peekEnd"), yaw: side * between(1.5, 2.5), roll: side * between(0.6, 1), pitch: -0.15, gazeX: side * between(0.16, 0.22), gazeY: -0.025, smile: 0 },
		{ span: time.span("tiltStart", "tiltEnd"), yaw: -side * between(0.6, 1), roll: -side * between(2.5, 3.5), pitch: 0.3, gazeX: -side * 0.06, gazeY: 0.05, smile: between(0.05, 0.09) },
		{ span: time.span("smileStart", "smileEnd"), yaw: side * 0.35, roll: side * between(0.6, 1), pitch: 0.25, gazeX: side * 0.025, gazeY: 0.035, smile: between(0.15, 0.25) },
	].map((event) => ({ ...event, headDelay: between(120, 200), bodyDelay: between(180, 300) }));

	// 不等长、轻微且非对称的呼吸；每段以零速度回到基线，整圈可平顺重复。
	const breaths = Array.from({ length: 7 }, () => ({ length: between(3800, 5200), amplitude: between(0.7, 1) }));
	const breathScale = time.durationMs / breaths.reduce((total, breath) => total + breath.length, 0);
	const breathPoints: [number, number][] = [[0, 0]];
	let breathAt = 0;
	for (const [index, breath] of breaths.entries()) {
		const end = index === breaths.length - 1 ? time.durationMs : breathAt + breath.length * breathScale;
		const duration = end - breathAt;
		breathPoints.push([breathAt + duration * 0.35, breath.amplitude], [breathAt + duration * 0.8, -breath.amplitude * 0.25], [end, 0]);
		breathAt = end;
	}
	const breath = keys(breathPoints);
	// 安静期也保留看得见的低速重心变化；两个轴独立抽取不等长关键点，不重复同一摆动节拍。
	const drift = (turns: number, min: number, max: number) => {
		// 第一秒即轻轻进入姿态，后续再放慢；避免启动数秒只有几十分之一度的变化。
		const entryMs = between(700, 950);
		const lengths = Array.from({ length: turns }, () => between(2800, 4600));
		const scale = (time.durationMs - entryMs) / lengths.reduce((total, length) => total + length, 0);
		const direction = rng() < 0.5 ? 1 : -1;
		const points: [number, number][] = [
			[0, 0],
			[entryMs, direction * between(min, max)],
		];
		let at = entryMs;
		for (const [index, length] of lengths.entries()) {
			const last = index === lengths.length - 1;
			at = last ? time.durationMs : at + length * scale;
			points.push([at, last ? 0 : direction * (index % 2 === 0 ? -1 : 1) * between(min, max)]);
		}
		return keys(points);
	};
	const driftYaw = drift(8, 1.8, 2.6);
	const driftRoll = drift(7, 1.8, 2.4);
	// 中段最多滞后 240ms，首尾恢复同一时间，避免延迟截断破坏循环收势。
	const bodyTime = (ms: number): number => {
		const phase = ms / time.durationMs;
		return ms - 240 * 4 * phase * (1 - phase);
	};

	// 先看再转头，身体更晚跟上；各段使用五次平滑曲线，停留后缓慢收回。
	const phrase = (span: TimeSpan, value: number, delay: number) => {
		const remaining = span.durationMs - delay;
		const points: [number, number][] = [[0, 0]];
		if (delay > 0) points.push([delay, 0]);
		points.push([delay + remaining * 0.28, value], [delay + remaining * 0.56, value], [span.durationMs, 0]);
		return { span, curve: keys(points) };
	};
	const headTurn = track(events.map((e) => phrase(e.span, e.yaw, e.headDelay)));
	const headTilt = track(events.map((e) => phrase(e.span, e.roll, e.headDelay)));
	const headNod = track(events.map((e) => phrase(e.span, e.pitch, e.headDelay)));
	const bodyYaw = track(events.map((e) => phrase(e.span, e.yaw * 0.22, e.headDelay + e.bodyDelay)));
	const bodyRoll = track(events.map((e) => phrase(e.span, e.roll * 0.22, e.headDelay + e.bodyDelay)));
	const bodyNod = track(events.map((e) => phrase(e.span, e.pitch * 0.2, e.headDelay + e.bodyDelay)));
	const headYaw = (ms: number): number => driftYaw(ms) + headTurn(ms);
	const headRoll = (ms: number): number => driftRoll(ms) + headTilt(ms);
	const headPitch = (ms: number): number => breath(ms) * 1.4 + headNod(ms);
	const gazeX = track(events.map((e) => phrase(e.span, e.gazeX, 0)));
	const gazeY = track(events.map((e) => phrase(e.span, e.gazeY, 0)));
	const smile = track(events.map((e) => phrase(e.span, e.smile, e.headDelay)));

	return {
		timeline: time,
		channels: {
			"head.yaw": offset(during(whole, headYaw)),
			"head.roll": offset(during(whole, headRoll)),
			"head.pitch": offset(during(whole, headPitch)),
			// 无 torso 槽位/absolute 接管时，Director 会加回头部底动；offset 将本 Idle 的头动换成小幅、滞后的身体目标。
			"torso.yaw": offset(during(whole, (ms) => driftYaw(bodyTime(ms)) * 0.55 + bodyYaw(ms) - headYaw(ms))),
			"torso.roll": offset(during(whole, (ms) => driftRoll(bodyTime(ms)) * 0.55 + bodyRoll(ms) - headRoll(ms))),
			"torso.pitch": offset(during(whole, (ms) => breath(bodyTime(ms)) * 1.3 + bodyNod(ms) - headPitch(ms))),
			"gaze.x": offset(gazeX),
			"gaze.y": offset(gazeY),
			"mouth.form": offset(smile),
		},
	};
};

export default cuteIdle;
