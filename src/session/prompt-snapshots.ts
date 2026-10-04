import type { InjectionProvenance } from "../runtime/events.js";

export const PROMPT_SNAPSHOT_ENTRY_TYPE = "uina.prompt.snapshot" as const;

export interface PromptSnapshotData {
	readonly turnNumber: number;
	readonly fingerprint: string;
	readonly systemPrompt: string;
	readonly injections: readonly InjectionProvenance[];
}

export interface PromptSnapshotRecord extends PromptSnapshotData {
	readonly id: string;
	readonly seq: number;
	readonly timestamp: string;
}

export function promptSnapshotFingerprint(systemPrompt: string, injections: readonly InjectionProvenance[]): string {
	return JSON.stringify({ systemPrompt, injections });
}

export function isPromptSnapshotData(value: unknown): value is PromptSnapshotData {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.turnNumber !== "number" ||
		!Number.isSafeInteger(record.turnNumber) ||
		record.turnNumber < 1 ||
		typeof record.fingerprint !== "string" ||
		typeof record.systemPrompt !== "string" ||
		!Array.isArray(record.injections)
	)
		return false;
	const validInjections = record.injections.every((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const contribution = item as Record<string, unknown>;
		return (
			typeof contribution.extension === "string" &&
			["messages", "systemPrompt", "model", "thinkingLevel", "projection"].includes(String(contribution.kind)) &&
			typeof contribution.chars === "number" &&
			Number.isFinite(contribution.chars) &&
			typeof contribution.preview === "string" &&
			(contribution.messageCount === undefined ||
				(typeof contribution.messageCount === "number" && Number.isFinite(contribution.messageCount)))
		);
	});
	return (
		validInjections &&
		record.fingerprint ===
			promptSnapshotFingerprint(record.systemPrompt, record.injections as readonly InjectionProvenance[])
	);
}

export function listPromptSnapshots(
	auxiliary: readonly {
		readonly kind: string;
		readonly id: string;
		readonly seq: number;
		readonly timestamp: string;
		readonly customType?: string;
		readonly data?: unknown;
	}[],
): PromptSnapshotRecord[] {
	return auxiliary
		.filter((entry) => entry.kind === "custom_entry" && entry.customType === PROMPT_SNAPSHOT_ENTRY_TYPE)
		.flatMap((entry) =>
			isPromptSnapshotData(entry.data)
				? [{ ...entry.data, id: entry.id, seq: entry.seq, timestamp: entry.timestamp }]
				: [],
		)
		.sort((a, b) => a.seq - b.seq);
}
