import type { CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import type { ActionAuthoring } from "../.uina/worlds/live2d/authoring/action.js";
import type { LocalChannels } from "../.uina/worlds/live2d/authoring/curves.js";
import { absolute, keys, motion, offset } from "../.uina/worlds/live2d/authoring/index.js";
import type { SpatialEvent } from "../.uina/worlds/live2d/authoring/spatial.js";

const withSpatial =
	(authoring: ActionAuthoring, spatial: readonly SpatialEvent[]): ActionAuthoring =>
	(rng) => ({ ...authoring(rng), spatial });

const hold = (durationMs: number, channels: LocalChannels): ActionAuthoring => motion(durationMs, channels);

export function perfCatalogSource(): CatalogSource {
	const wave = hold(1800, {
		"head.yaw": offset(
			keys([
				[0, 0],
				[400, 3],
				[900, -3],
				[1400, 2],
				[1800, 0],
			]),
		),
		"torso.roll": offset(
			keys([
				[0, 0],
				[700, 2],
				[1300, -2],
				[1800, 0],
			]),
		),
	});
	return {
		motions: {
			nod: {
				description: "test-only body gesture",
				motion: hold(950, {
					"head.pitch": offset(
						keys([
							[0, 0],
							[250, -4],
							[650, 2],
							[950, 0],
						]),
					),
				}),
				playback: { fadeOutMs: 0 },
			},
			wink: {
				description: "test-only eyelid takeover",
				motion: hold(700, {
					"eyes.left.open": keys([
						[0, 0.55],
						[100, 0],
						[500, 0],
						[700, 0.55],
					]),
					"eyes.right.open": absolute(
						keys([
							[0, 1],
							[700, 1],
						]),
					),
				}),
				playback: { fadeInMs: 0, fadeOutMs: 80 },
			},
			glance: {
				description: "test-only gaze handoff",
				motion: hold(1200, {
					"gaze.x": absolute(
						keys([
							[0, 0],
							[1200, 0],
						]),
					),
				}),
			},
			curious: {
				description: "test-only body override",
				motion: hold(1800, {
					"head.roll": offset(
						keys([
							[0, 0],
							[400, 2],
							[1000, 3],
							[1800, 0],
						]),
					),
				}),
			},
			surprise: {
				description: "test-only speech mix",
				motion: hold(1600, {
					"mouth.open": absolute(
						keys([
							[0, 0],
							[1600, 0],
						]),
					),
				}),
			},
			startle: {
				description: "test-only speech interruption",
				motion: hold(1600, {
					"mouth.open": absolute(
						keys([
							[0, 0],
							[1600, 0],
						]),
					),
				}),
				playback: { resetVelocity: true },
			},
			joy_hop: {
				description: "test-only spatial sequence",
				motion: withSpatial(
					hold(1200, {
						"head.pitch": offset(
							keys([
								[0, 0],
								[300, -2],
								[800, 2],
								[1200, 0],
							]),
						),
					}),
					[
						{ during: { startMs: 0, endMs: 120, durationMs: 120 }, transform: { delta: { y: -0.05 } } },
						{ during: { startMs: 120, endMs: 340, durationMs: 220 }, transform: { delta: { y: 0.12 } } },
						{ during: { startMs: 340, endMs: 620, durationMs: 280 }, transform: { delta: { y: 0 } } },
						{ during: { startMs: 620, endMs: 800, durationMs: 180 }, transform: { delta: { y: 0.03 } } },
						{ during: { startMs: 800, endMs: 1100, durationMs: 300 }, transform: { delta: { y: 0 } } },
					],
				),
				playback: { fadeOutMs: 0 },
			},
			fx_probe: {
				description: "test-only effect ownership probe",
				motion: withSpatial(
					hold(800, {
						"head.yaw": absolute(
							keys([
								[0, 2],
								[800, 2],
							]),
						),
					}),
					[
						{
							during: { startMs: 0, endMs: 150, durationMs: 150 },
							transform: { delta: { y: 0.05 } },
							effects: {
								tint: { r: 135, g: 125, b: 120 },
								postProcessing: { on: true, preset: "Grayscale", fadeTime: 0.1 },
							},
						},
						{ during: { startMs: 150, endMs: 450, durationMs: 300 }, transform: { delta: { y: 0 } } },
					],
				),
			},
			fx_plain: {
				description: "test-only spatial ownership control",
				motion: withSpatial(
					hold(800, {
						"head.yaw": absolute(
							keys([
								[0, 2],
								[800, 2],
							]),
						),
					}),
					[
						{ during: { startMs: 0, endMs: 150, durationMs: 150 }, transform: { delta: { y: 0.05 } } },
						{ during: { startMs: 150, endMs: 450, durationMs: 300 }, transform: { delta: { y: 0 } } },
					],
				),
			},
		},
		background: {
			idle: hold(3800, {
				"head.roll": absolute(
					keys([
						[0, 3],
						[3800, 3],
					]),
				),
			}),
			thinking: hold(3600, {
				"head.roll": absolute(
					keys([
						[0, 0.5],
						[3600, 0.5],
					]),
				),
				"gaze.y": absolute(
					keys([
						[0, 0.4],
						[3600, 0.4],
					]),
				),
			}),
			ambient: {
				sway: {
					description: "test-only finite phrase rotation",
					aliases: ["test摇摆"],
					motion: wave,
					variants: [
						hold(1800, {
							"head.yaw": offset(
								keys([
									[0, 0],
									[900, 2],
									[1800, 0],
								]),
							),
						}),
						hold(1800, {
							"head.yaw": offset(
								keys([
									[0, 0],
									[900, -2],
									[1800, 0],
								]),
							),
						}),
					],
				},
			},
		},
		expressions: {
			test_expression: {
				description: "Synthetic expression fixture",
				values: { "mouth.form": 0.42, "eyes.left.open": 0.62, "eyes.right.open": 0.62 },
				transitionMs: 0,
			},
		},
		costumes: [{ id: "test-costume", description: "测试外观", hotkeyID: "test-hotkey" }],
	};
}
