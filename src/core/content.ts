import type { Model, ModelRequest } from "./types.js";
/** Image bytes travel with the message; file paths are not image content. */
export interface ImageContent {
	readonly type: "image";
	readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	readonly data: string;
	readonly alt?: string;
}
export function validImages(value: unknown): value is ImageContent[] | undefined {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(
				(image) =>
					image &&
					image.type === "image" &&
					["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType) &&
					typeof image.data === "string" &&
					image.data.length > 0 &&
					image.data.length % 4 === 0 &&
					/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) &&
					(image.alt === undefined || typeof image.alt === "string"),
			))
	);
}
export function assertImageInput(model: Model, request: ModelRequest): void {
	for (const message of request.messages) {
		if (!validImages(message.images)) throw new Error("图片内容无效");
		if (!message.images?.length) continue;
		if (message.role !== "user" && message.role !== "tool") throw new Error("图片仅支持 user/tool 输入");
		if (model.imageInput === false) throw new Error("模型 " + model.name + " 不支持图片输入");
	}
}
export function imageNotice(images?: readonly ImageContent[]): string {
	return images?.length ? "\n[图片: " + images.map((image) => image.alt ?? image.mimeType).join(", ") + "]" : "";
}
