export class ProviderProtocolError extends Error {
	readonly eventIndex?: number;

	constructor(message: string, eventIndex?: number) {
		super(message);
		this.name = "ProviderProtocolError";
		this.eventIndex = eventIndex;
	}
}

/** Parse standard SSE event framing and pass each concatenated data payload onward. */
export async function parseSSE(
	body: ReadableStream<Uint8Array>,
	onData: (data: string, index: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];
	let eventIndex = 0;
	const cancelReader = (): void => {
		void reader.cancel(signal?.reason);
	};
	if (signal) signal.addEventListener("abort", cancelReader, { once: true });

	const dispatch = (): void => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		onData(data, eventIndex++);
	};

	const consumeLine = (line: string): void => {
		const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (normalized === "") {
			dispatch();
			return;
		}
		if (normalized.startsWith(":")) return;
		const colon = normalized.indexOf(":");
		const field = colon < 0 ? normalized : normalized.slice(0, colon);
		if (field !== "data") return;
		let value = colon < 0 ? "" : normalized.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		dataLines.push(value);
	};

	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while (true) {
				const lf = buffer.indexOf("\n");
				const cr = buffer.indexOf("\r");
				newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
				if (newline < 0) break;
				const isCr = buffer[newline] === "\r";
				if (isCr && newline === buffer.length - 1) break;
				consumeLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (isCr && buffer.startsWith("\n")) buffer = buffer.slice(1);
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) consumeLine(buffer);
		dispatch();
		signal?.throwIfAborted();
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancelReader);
	}
}
