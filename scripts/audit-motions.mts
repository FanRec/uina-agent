import { compileAction, sampleAction, type ActionAuthoring } from "../.uina/worlds/live2d/authoring/action.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { MO_CATALOG_SOURCE } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

async function runAudit() {
	const rig = (await loadRig(MO_MODEL_ID))!;
	const baseline: Record<string, number> = {};
	for (const [k, c] of Object.entries(rig.controls)) baseline[k] = c.neutral;

	const actions: Array<{ name: string; fn: ActionAuthoring }> = [];
	for (const [name, entry] of Object.entries(MO_CATALOG_SOURCE.motions ?? {})) {
		actions.push({ name, fn: entry.motion });
		if (entry.variants) {
			entry.variants.forEach((v, i) => actions.push({ name: `${name}_var${i + 1}`, fn: v }));
		}
	}
	if (MO_CATALOG_SOURCE.background?.idle) {
		actions.push({ name: "background_idle", fn: MO_CATALOG_SOURCE.background.idle });
	}
	if (MO_CATALOG_SOURCE.background?.thinking) {
		actions.push({ name: "background_thinking", fn: MO_CATALOG_SOURCE.background.thinking });
	}
	for (const [name, entry] of Object.entries(MO_CATALOG_SOURCE.background?.ambient ?? {})) {
		actions.push({ name: `ambient_${name}`, fn: entry.motion });
		if (entry.variants) {
			entry.variants.forEach((v, i) => actions.push({ name: `ambient_${name}_var${i + 1}`, fn: v }));
		}
	}

	console.log(`[AUDIT] Auditing ${actions.length} actions and variants with 5 representative RNG values...`);
	let issues = 0;
	let warnings = 0;

	for (const item of actions) {
		for (const rngVal of [0.0, 0.25, 0.5, 0.75, 1.0]) {
			const compiled = compileAction(item.fn, rig.controls, () => rngVal);
			const T = compiled.durationMs;
			const director = new MotionDirector(rig.controls, { diagnostics: true });
			director.play(compiled, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0, atomic: false });

			// 1. Boundary check at t=0 and t=T
			const s0 = sampleAction(compiled, 0, baseline);
			const sT = sampleAction(compiled, T, baseline);
			for (const axis of compiled.axes) {
				const diff0 = Math.abs(s0[axis]! - baseline[axis]!);
				const diffT = Math.abs(sT[axis]! - baseline[axis]!);
				if (diff0 > 1e-3) {
					console.error(
						`[ERROR][${item.name}] rng=${rngVal} t=0 ${axis} offset !== 0 (${(s0[axis]! - baseline[axis]!).toFixed(4)})`,
					);
					issues++;
				}
				if (diffT > 1e-3) {
					console.error(
						`[ERROR][${item.name}] rng=${rngVal} t=T(${T}) ${axis} offset !== 0 (${(sT[axis]! - baseline[axis]!).toFixed(4)})`,
					);
					issues++;
				}
			}

			// 2. Continuous sweep every 5ms for range limits, clamp bounds, and discontinuities
			let prevSample = s0;
			for (let t = 0; t <= T; t += 5) {
				const cur = sampleAction(compiled, t, baseline);
				if (t > 0) {
					director.step(5);
					for (const hit of director.getActionDiagnostics()?.clampHits ?? []) {
						console.error(
							`[ERROR][${item.name}] rng=${rngVal} t=${t}ms composed ${hit.axis}=${hit.requested} clamped to ${hit.value}`,
						);
						issues++;
					}
				}
				for (const axis of compiled.axes) {
					const val = cur[axis]!;
					const ctrl = rig.controls[axis]!;
					// 身体 offset 是 head-follow 的修正量，其最终范围由上面的真实 Director 检查。
					const bodyOffset =
						axis.startsWith("torso.") &&
						compiled.channels.some((c) => c.axis === axis && c.space === "baseline-offset");
					if (!bodyOffset && (val < ctrl.min - 1e-4 || val > ctrl.max + 1e-4)) {
						console.error(
							`[ERROR][${item.name}] rng=${rngVal} t=${t}ms ${axis}=${val.toFixed(3)} EXCEEDS [${ctrl.min}, ${ctrl.max}]`,
						);
						issues++;
					}

					// Check step jump per 5ms: detects piecewise discontinuities
					const delta = Math.abs(cur[axis]! - prevSample[axis]!);
					// In 5ms, eye/mouth jump > 0.2 or angle jump > 1.8 indicates a jump discontinuity
					const threshold =
						axis.startsWith("eyes.") || axis.startsWith("mouth.") || axis.startsWith("gaze.") ? 0.25 : 2.0;
					if (delta > threshold && t > 0) {
						console.warn(`[WARN][${item.name}] rng=${rngVal} t=${t}ms ${axis} large jump: ${delta.toFixed(3)} in 5ms`);
						warnings++;
					}
				}
				prevSample = cur;
			}
		}
	}

	console.log(`[AUDIT COMPLETE] Audited ${actions.length} actions: ${issues} errors, ${warnings} warnings.`);
	process.exit(issues > 0 ? 1 : 0);
}

runAudit().catch((err) => {
	console.error(err);
	process.exit(1);
});
