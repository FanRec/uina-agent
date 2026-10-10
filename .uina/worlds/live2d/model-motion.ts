import type { VTSClient } from "./vts-client.js";
import { abortableDelay } from "./types.js";

/** Physical model movement uses VTS's renderer interpolation; request ACKs are not animation frames. */
export async function performModelFlip(
	client: VTSClient,
	signal?: AbortSignal,
): Promise<{ aborted: boolean; cleanupFailed: boolean }> {
	if (signal?.aborted) return { aborted: true, cleanupFailed: false };
	const profile = client.getModelProfile();
	const sameModel = () => client.isConnected() && client.getModelProfile() === profile;
	const original = await client.getModelPosition();
	if (!sameModel()) throw new Error("VTS model changed before flip");
	const steps = 24;
	const cadenceMs = 40;
	const fadeMs = 80;
	let cleanupFailed = false;
	try {
		for (let step = 1; step <= steps && !signal?.aborted; step++) {
			if (!sameModel()) throw new Error("VTS model changed during flip");
			const phase = step / steps;
			const started = performance.now();
			await client.moveModel({
				positionY: original.positionY + Math.sin(phase * Math.PI) * 0.22,
				rotation: (((original.rotation + phase * 360) % 360) + 360) % 360,
				timeInSeconds: fadeMs / 1000,
				valuesAreRelativeToModel: false,
			});
			// Preserve every intermediate angle even when an ACK is slow. Do not burst or fast-forward.
			await abortableDelay(Math.max(0, cadenceMs - (performance.now() - started)), signal);
		}
		if (!signal?.aborted) await abortableDelay(fadeMs, signal);
	} finally {
		try {
			// Never restore one model's transform onto its replacement.
			if (!sameModel()) throw new Error("VTS model changed before restoration");
			await client.moveModel({ ...original, timeInSeconds: 0.15, valuesAreRelativeToModel: false });
			await abortableDelay(180);
			if (!sameModel()) throw new Error("VTS model changed during restoration");
			const restored = await client.getModelPosition();
			const rotationError = Math.abs(((restored.rotation - original.rotation + 540) % 360) - 180);
			cleanupFailed =
				Math.abs(restored.positionX - original.positionX) > 0.005 ||
				Math.abs(restored.positionY - original.positionY) > 0.005 ||
				rotationError > 0.5 ||
				Math.abs(restored.size - original.size) > 0.05;
		} catch {
			cleanupFailed = true;
		}
	}
	return { aborted: signal?.aborted ?? false, cleanupFailed };
}
