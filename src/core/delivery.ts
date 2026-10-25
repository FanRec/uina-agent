import type { HostDeliveryTag } from "./types.js";

export const deliveryKey = (namespace: string, key: string): string => JSON.stringify([namespace, key]);

export function validDeliveryTag(value: unknown): value is HostDeliveryTag {
	if (!value || typeof value !== "object") return false;
	const tag = value as Record<string, unknown>;
	return (
		typeof tag.key === "string" &&
		tag.key.trim().length > 0 &&
		typeof tag.attempt === "string" &&
		tag.attempt.trim().length > 0
	);
}

export function validDeliveryMetadata(value: { receipt?: unknown; receiptNamespace?: unknown }): boolean {
	return (
		(value.receipt === undefined && value.receiptNamespace === undefined) ||
		(validDeliveryTag(value.receipt) &&
			typeof value.receiptNamespace === "string" &&
			value.receiptNamespace.trim().length > 0)
	);
}
