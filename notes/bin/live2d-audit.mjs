// 重算：从 BASE_POSES + FACE/HEAD 表 + compose 地板 + retargeter 融合，算最终送进 VTS 的值
const clamp = (n, v) => {
	if (n.startsWith("ParamAngle")) return Math.max(-30, Math.min(30, v));
	if (n.startsWith("ParamBodyAngle")) return Math.max(-15, Math.min(15, v));
	if (n.includes("Eye") && n.includes("Open")) return Math.max(0, Math.min(2, v));
	if (n.startsWith("ParamEyeBall")) return Math.max(-1, Math.min(1, v));
	if (n.includes("Smile") || n === "ParamCheek" || n === "ParamBreath" || n === "ParamMouthOpenY")
		return Math.max(0, Math.min(1, v));
	if (n === "ParamMouthForm" || n.startsWith("ParamBrow")) return Math.max(-1, Math.min(1, v));
	return v;
};

const BASE = {
	playful: { ParamAngleZ: 18, ParamAngleX: -5, ParamBodyAngleX: 8, ParamEyeBallX: 0.35, ParamEyeBallY: 0.15, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthForm: 0.8, ParamCheek: 0.5, ParamBrowLY: 0.2, ParamBrowRY: 0.2 },
	focused: { ParamAngleY: 12, ParamAngleX: 0, ParamAngleZ: 0, ParamBodyAngleY: 8, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamEyeBallX: 0, ParamEyeBallY: 0.15, ParamBrowLY: -0.15, ParamBrowRY: -0.15, ParamMouthForm: 0.1 },
	relaxed: { ParamAngleY: -10, ParamAngleZ: -8, ParamAngleX: 4, ParamBodyAngleY: -6, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamEyeBallX: 0, ParamEyeBallY: -0.2, ParamMouthForm: 0.3 },
	streamer_hype: { ParamAngleY: 10, ParamAngleZ: 6, ParamAngleX: 0, ParamBodyAngleY: 12, ParamEyeLOpen: 1.15, ParamEyeROpen: 1.15, ParamEyeBallX: 0, ParamEyeBallY: 0.1, ParamMouthForm: 0.9, ParamBrowLY: 0.3, ParamBrowRY: 0.3, ParamCheek: 0.4 },
	shy_side: { ParamAngleZ: 14, ParamAngleX: -10, ParamAngleY: -6, ParamBodyAngleX: -10, ParamEyeBallX: 0.65, ParamEyeBallY: -0.2, ParamEyeLOpen: 0.85, ParamEyeROpen: 0.85, ParamCheek: 0.85, ParamMouthForm: 0.4, ParamEyeLSmile: 0.5, ParamEyeRSmile: 0.5 },
};
const HEAD = { tilt_left: { ParamAngleZ: 18 }, tilt_right: { ParamAngleZ: -18 }, nod: { ParamAngleY: -20 }, shake: { ParamAngleX: 18 }, lowered: { ParamAngleY: -16 }, lifted: { ParamAngleY: 16 } };

console.log("=== (a) 基准 + head additive 动作的最终 target（ParamAngle 墙 ±30）===");
let hits = 0;
for (const [pose, base] of Object.entries(BASE)) {
	for (const [hp, w] of Object.entries(HEAD)) {
		for (const [pn, pv] of Object.entries(w)) {
			const raw = (base[pn] ?? 0) + pv;
			const fin = clamp(pn, raw);
			if (raw !== fin) { hits++; console.log("  " + pose + " + " + hp + ": " + pn + " " + raw + " -> 钳到 " + fin + "  【撞墙，损失 " + (raw - fin).toFixed(1) + "】"); }
		}
	}
}
console.log("  撞墙组合数 = " + hits);

console.log("\n=== (b) 头+身融合（retargeter: FaceAngleY = head + body*0.75，钳 ±20）===");
for (const p of Object.keys(BASE)) {
	const hy = BASE[p].ParamAngleY ?? 0, by = BASE[p].ParamBodyAngleY ?? 0;
	const fused = Math.max(-20, Math.min(20, hy + by * 0.75));
	console.log("  " + p.padEnd(14) + " headY=" + String(hy).padStart(5) + " bodyY=" + String(by).padStart(5) + " -> FaceAngleY=" + fused.toFixed(2) + (hy > 0 && by > 0 ? "   <= 头抬+身后倾=后仰感" : ""));
}

console.log("\n=== (c) FACE 表经 compose 待机微笑地板（mouth 通道 max(v, 0.25)）后的实际嘴角 ===");
const FLOOR = 0.25;
const FACE = { shy: 0.3, pout: -0.9, smug: 0.9, sparkle: 0.8, tender_smile: 0.85, laugh: 1.0, smug_grin: 1.0, winking: 0.8, shocked: null, sleepy_yawn: null };
for (const [k, v] of Object.entries(FACE)) {
	if (v === null) { console.log("  " + k.padEnd(12) + " MouthForm 未设定      -> 实际 0.25（吃待机底色）"); continue; }
	const after = Math.max(v, FLOOR);
	console.log("  " + k.padEnd(12) + " 请求 " + String(v).padStart(5) + "  -> 实际 " + after.toFixed(2) + (after !== v ? "   【意图被地板吃掉 " + (after - v).toFixed(2) + "】" : ""));
}

console.log("\n=== (d) 眼笑动态范围（additive/fixed + 生理噪声常驻 0.15，钳位 [0,1]）===");
for (const [k, val, mode] of [["shy", 0.7, "add"], ["smug R", 0.9, "add"], ["tender_smile", 0.95, "add"], ["sparkle", 0.8, "add"], ["laugh", 1.0, "fixed"], ["smug_grin R", 0.95, "add"], ["shy_side 基准", 0.5, "base"]]) {
	const w = val + 0.15, fin = clamp("ParamEyeLSmile", w);
	console.log("  " + k.padEnd(14) + mode.padEnd(6) + " 目标 " + val + " +0.15 = " + w.toFixed(2) + " -> " + fin.toFixed(2) + (fin >= 1 ? "  【饱和】" : ""));
}

console.log("\n=== (e) 语流律动幅度 vs 感知阈（注释自称 ±6° 低于感知阈）===");
const act = 1.0;
console.log("  躯干 X 摆幅 = ±" + (9.0 * act).toFixed(1) + "°   ParamBodyAngle 墙 ±15 -> 占 " + ((9 / 15) * 100).toFixed(0) + "%");
console.log("  躯干 Y = ±" + (5.5 * act).toFixed(1) + "°  躯干 Z = ±" + (5.0 * act).toFixed(1) + "°");
console.log("  头 Z 摆幅 = ±" + (5.0 * act).toFixed(1) + "°  头 X = ±" + (3.5 * act).toFixed(1) + "°  头 Y(点头) = ±" + (4.5 * act).toFixed(1) + "°");
console.log("  融合进 FaceAngleZ 后 = 头Z 5.0*? + 躯干Z 5.0*0.75 = " + (5.0 + 5.0 * 0.75).toFixed(2) + "° (墙 ±25)");
console.log("  呼吸 speechActivity=1 时深度收窄 40% -> ParamBreath 峰值 " + (1 * 0.6).toFixed(2));

console.log("\n=== (f) 眨眼时长 vs 60Hz 帧 ===");
console.log("  闭眼 60ms = " + (60 / (1000 / 60)).toFixed(1) + " 帧；睁开 100ms = " + (100 / (1000 / 60)).toFixed(1) + " 帧");
console.log("  连眨总时长 = " + (60 + 100 + 50 + 50 + 80) + "ms = " + ((60 + 100 + 50 + 50 + 80) / (1000 / 60)).toFixed(1) + " 帧");
console.log("  泊松间隔 2500~5500ms，均值 4000ms -> 平均每 " + (4000 / (1000 / 60)).toFixed(0) + " 帧一次");

console.log("\n=== (g) 呼吸周期 vs 语流律动周期（是否撞频）===");
console.log("  呼吸 phase*1.74 -> 周期 " + ((2 * Math.PI) / 1.74).toFixed(2) + "s");
console.log("  躯干 X 主谐波 p*3.8 -> 周期 " + ((2 * Math.PI) / 3.8).toFixed(2) + "s；副谐波 p*1.9 -> " + ((2 * Math.PI) / 1.9).toFixed(2) + "s");
console.log("  头部 Z 语流 p*3.8 -> " + ((2 * Math.PI) / 3.8).toFixed(2) + "s（与躯干 X 同频，注释称\"有机耦合\"）");
console.log("  头部 Y 点头 p*3.8 + p*7.6 -> " + ((2 * Math.PI) / 7.6).toFixed(2) + "s（7.6 = 3.8*2，整数倍=每摆动2次点头）");
