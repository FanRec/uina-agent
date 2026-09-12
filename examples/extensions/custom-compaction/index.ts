import type { ExtensionAPI } from "../../../src/extensions/index.js";
/** Replaces summary generation while the runtime retains cancellation and commit ownership. */
export default function activate(api: ExtensionAPI): void {
	api.registerCompactor(async (request, signal) => {
		let summary = "";
		let finished = false;
		await api.models.stream(
			request.model,
			{
				messages: [
					{
						role: "system",
						content:
							request.instruction ??
							"Summarize the supplied history, preserving facts, sources, preferences and unresolved commitments. Return only the summary.",
					},
					{
						role: "user",
						content: request.history
							.slice(0, request.suggestedKeepFrom)
							.map(
								(message) =>
									"[" +
									message.role +
									"] " +
									message.content +
									(message.images?.length
										? " [images: " + message.images.map((image) => image.alt ?? image.mimeType).join(", ") + "]"
										: ""),
							)
							.join("\n"),
					},
				],
			},
			(delta) => {
				if (delta.kind === "text") summary += delta.text;
				if (delta.kind === "tool_call") throw new Error("Summarizer returned a tool call");
				if (delta.kind === "finish") {
					if (delta.reason !== "stop") throw new Error("Summary incomplete: " + delta.reason);
					finished = true;
				}
			},
			signal,
		);
		signal.throwIfAborted();
		if (!finished || !summary.trim()) throw new Error("Summary is empty or incomplete");
		return { summary, keepFrom: request.suggestedKeepFrom };
	});
}
