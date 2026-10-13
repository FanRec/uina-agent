import { createHash } from "node:crypto";
import type { ModelProfile } from "./profile.js";
import type { ModelRig } from "./rig.js";
import { VTSInputSetupError, type VTSClient } from "./vts-client.js";

/** MO's independent body rotations, mapped from VTS custom inputs through the model rig. */
export const BODY_ROTATION_AXES = ["torso.yaw", "torso.pitch", "torso.roll"] as const;
export type BodyRotationAxis = (typeof BODY_ROTATION_AXES)[number];

export function bodyInputName(modelID: string, axis: BodyRotationAxis): string {
	const hash = createHash("sha256").update(modelID).digest("hex").slice(0, 12);
	const direction = axis.slice("torso.".length);
	return `UinaBody${hash}${direction[0]!.toUpperCase()}${direction.slice(1)}`;
}

export interface PreparedBodyInput {
	axis: BodyRotationAxis;
	input: string;
	output: string;
	state: "created" | "existing";
}

export type BodyInputPreparationResult =
	| { status: "prepared"; inputs: readonly PreparedBodyInput[] }
	| { status: "cancelled"; reason: "cancelled"; message: string; inputs: readonly PreparedBodyInput[] }
	| {
			status: "failed" | "unknown";
			reason: string;
			message: string;
			inputs: readonly PreparedBodyInput[];
			expectedInputs: readonly string[];
	  };

/** Create the rig-declared inputs and preserve confirmed partial effects on failure or cancellation. */
export async function prepareBodyInputs(
	rig: ModelRig,
	client: Pick<VTSClient, "ensureInput">,
	signal?: AbortSignal,
): Promise<BodyInputPreparationResult> {
	const expectedInputs = BODY_ROTATION_AXES.map((axis) => bodyInputName(rig.modelID, axis));
	const inputs: PreparedBodyInput[] = [];
	const failure = (status: "failed" | "unknown", reason: string, message: string) => ({
		status,
		reason,
		message,
		inputs: [...inputs],
		expectedInputs,
	});
	const cancelled = () => ({
		status: "cancelled" as const,
		reason: "cancelled" as const,
		message: "VTS 身体输入准备已取消。",
		inputs: [...inputs],
	});

	for (const axis of BODY_ROTATION_AXES) {
		if (signal?.aborted) return cancelled();
		const control = rig.controls[axis];
		const targets = rig.bindings[axis];
		if (!control || targets?.length !== 1)
			return failure("failed", "invalid_body_rig", `躯干 rig 必须为 ${axis} 声明一个控制和一个绑定。`);
		const target = targets[0]!;
		if (target.input !== bodyInputName(rig.modelID, axis))
			return failure("failed", "invalid_body_rig", `躯干 rig 输入名不符合模型隔离命名规则：${axis}。`);

		try {
			const state = await client.ensureInput({
				name: target.input,
				min: control.min,
				max: control.max,
				defaultValue: control.neutral,
			});
			inputs.push({ axis, input: target.input, output: target.parameter, state });
		} catch (error) {
			if (error instanceof VTSInputSetupError) return failure(error.outcome, error.reason, error.message);
			return failure(
				"unknown",
				"body_input_prepare_unconfirmed",
				`VTS 输入结果未确认：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// ensureInput is not abortable; a final check prevents cancellation during the last request becoming success.
	if (signal?.aborted) return cancelled();
	return { status: "prepared", inputs };
}

export type BodyMappingAxisStatus =
	| "ready"
	| "unsupported"
	| "invalid_rig"
	| "model_not_ready"
	| "input_list_unavailable"
	| "missing_input"
	| "not_custom_input"
	| "input_range_mismatch"
	| "unmapped"
	| "ambiguous_mapping"
	| "wrong_output"
	| "missing_output_parameter";

export interface BodyMappingStatus {
	ready: boolean;
	modelID: string | null;
	axes: Record<BodyRotationAxis, { input: string; output: string | null; status: BodyMappingAxisStatus }>;
}

/** Pure interpretation of rig, VTS input, saved mapping and model-parameter facts for status.detail. */
export function inspectBodyMapping(rig: ModelRig | undefined, profile: ModelProfile | undefined): BodyMappingStatus {
	const axes = Object.fromEntries(
		BODY_ROTATION_AXES.map((axis) => {
			const expectedInput = bodyInputName(rig?.modelID ?? "unavailable", axis);
			const targets = rig?.bindings[axis];
			const target = targets?.length === 1 ? targets[0] : undefined;
			const inputName = target?.input ?? expectedInput;
			let status: BodyMappingAxisStatus = "ready";

			if (!rig || !rig.controls[axis]) status = "unsupported";
			else if (!target || target.input !== expectedInput) status = "invalid_rig";
			else if (!profile || profile.modelID !== rig.modelID) status = "model_not_ready";
			else if (!profile.inputs) status = "input_list_unavailable";
			else {
				const input = profile.inputs.find((item) => item.name === inputName);
				if (!input) status = "missing_input";
				else if (input.custom !== true) status = "not_custom_input";
				else {
					const control = rig.controls[axis]!;
					if (input.min !== control.min || input.max !== control.max || input.defaultValue !== control.neutral)
						status = "input_range_mismatch";
					else {
						const mappings = profile.mappings.filter((mapping) => mapping.input === inputName);
						if (!mappings.length) status = "unmapped";
						else if (mappings.length > 1) status = "ambiguous_mapping";
						else if (mappings[0]!.output !== target.parameter) status = "wrong_output";
						else if (!profile.parameterRanges?.[target.parameter]) status = "missing_output_parameter";
					}
				}
			}
			return [axis, { input: inputName, output: target?.parameter ?? null, status }];
		}),
	) as BodyMappingStatus["axes"];
	return {
		ready: BODY_ROTATION_AXES.every((axis) => axes[axis].status === "ready"),
		modelID: profile?.modelID ?? null,
		axes,
	};
}
