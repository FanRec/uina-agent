import { AXES, AXIS_NAMES } from "../.uina/worlds/live2d/motion-axes.js";
import type { ModelProfile, ModelParameterRange } from "../.uina/worlds/live2d/model-profile.js";

/** An explicit fully prepared device; its arbitrary output IDs exercise the adapter seam. */
export function independentModelFixture(): ModelProfile {
	const profile: ModelProfile = {
		modelID: "prepared",
		modelName: "prepared fixture",
		physicsOutputs: [],
		inputs: [],
		mappings: [],
		parameterRanges: {},
		adapterDefinition: { version: 1, axes: {} },
	};
	const mappings = [],
		inputs = [],
		ranges: Record<string, ModelParameterRange> = {};
	for (const [index, axis] of AXIS_NAMES.entries()) {
		const metadata = AXES[axis],
			parameter = `Custom${index}`,
			input = `Drive${index}`;
		mappings.push({
			input,
			output: parameter,
			inputMin: metadata.min,
			inputMax: metadata.max,
			outputMin: metadata.min,
			outputMax: metadata.max,
		});
		inputs.push({ name: input, min: metadata.min, max: metadata.max, defaultValue: metadata.neutral });
		ranges[parameter] = { min: metadata.min, max: metadata.max, defaultValue: metadata.neutral };
		profile.adapterDefinition!.axes[axis] = [{ parameter }];
	}
	return { ...profile, mappings, inputs, parameterRanges: ranges };
}
