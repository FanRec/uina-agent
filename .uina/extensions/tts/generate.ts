import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Tool, ToolExecutionResult } from "../../../src/tools/broker.js";
import { TtsGenerationError, type TtsBridgeClient } from "./client.js";
import { resolveGenerationTimeout } from "./config.js";

interface GenerateOptions {
	cwd: string;
	client: Pick<TtsBridgeClient, "generate">;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function wavDuration(bytes: Uint8Array): number {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	function invalid(): never {
		throw new TtsGenerationError("合成返回的 WAV 无效或不完整");
	}
	if (
		buffer.length < 44 ||
		buffer.toString("latin1", 0, 4) !== "RIFF" ||
		buffer.toString("latin1", 8, 12) !== "WAVE" ||
		buffer.readUInt32LE(4) + 8 !== buffer.length
	)
		invalid();
	let frameSize = 0;
	let sampleRate = 0;
	let dataSize = 0;
	let hasData = false;
	let offset = 12;
	while (offset < buffer.length) {
		if (offset + 8 > buffer.length) invalid();
		const name = buffer.toString("latin1", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		offset += 8;
		if (offset + size > buffer.length) invalid();
		if (name === "fmt ") {
			if (frameSize || size < 16 || buffer.readUInt16LE(offset) !== 1) invalid();
			const channels = buffer.readUInt16LE(offset + 2);
			sampleRate = buffer.readUInt32LE(offset + 4);
			frameSize = buffer.readUInt16LE(offset + 12);
			const bits = buffer.readUInt16LE(offset + 14);
			if (
				!channels ||
				!sampleRate ||
				![8, 16, 24, 32].includes(bits) ||
				frameSize !== (channels * bits) / 8 ||
				buffer.readUInt32LE(offset + 8) !== sampleRate * frameSize
			)
				invalid();
		} else if (name === "data") {
			if (!frameSize || hasData || !size || size % frameSize) invalid();
			hasData = true;
			dataSize = size;
		}
		offset += size + (size % 2);
	}
	if (offset !== buffer.length || !hasData) invalid();
	return Math.round((dataSize / frameSize / sampleRate) * 1_000_000) / 1000;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		function abort(): void {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		}
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Owns validation, exclusive writes, the publication boundary and intermediate cleanup. */
async function publishWav(directory: string, audio: Uint8Array, signal: AbortSignal): Promise<ToolExecutionResult> {
	signal.throwIfAborted();
	const durationMs = wavDuration(audio);
	const name = `tts-${randomUUID()}`;
	const temporary = join(directory, `.${name}.part`);
	const path = join(directory, `${name}.wav`);
	let tempOwned = false;
	let published = false;
	let failure: unknown;
	let cleanupError: string | undefined;
	try {
		await mkdir(directory, { recursive: true });
		signal.throwIfAborted();
		const handle = await open(temporary, "wx");
		tempOwned = true;
		try {
			signal.throwIfAborted();
			await handle.writeFile(audio);
			await handle.sync();
		} finally {
			await handle.close();
		}
		signal.throwIfAborted();
		await link(temporary, path);
		published = true;
	} catch (error) {
		failure = error;
	}
	if (tempOwned) {
		try {
			await rm(temporary);
		} catch (error) {
			cleanupError = String(error);
		}
	}
	const cleanup = cleanupError ? { temporary, cleanupError } : undefined;
	if (published) {
		return {
			status: "succeeded",
			result: JSON.stringify({ resource: { kind: "file", path }, durationMs }),
			...(cleanup ? { details: cleanup } : {}),
		};
	}
	throw new TtsGenerationError("音频文件写入失败，请检查项目临时目录和磁盘", {
		cause: {
			error: String(failure),
			...cleanup,
			...(signal.aborted && failure === signal.reason ? { abortReason: signal.reason } : {}),
		},
	});
}

export function createTtsGenerateTool(options: GenerateOptions): Tool {
	const outputDir = resolve(options.cwd, "uina", "tmp");
	const timeoutMs = resolveGenerationTimeout(options.timeoutMs);
	return {
		executionMode: "sequential",
		def: {
			type: "function",
			function: {
				name: "tts_generate",
				description: "将 text 合成为 WAV 文件，不播放。返回 resource 可交给支持文件的工具。",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["text"],
					properties: { text: { type: "string", minLength: 1, description: "要合成的完整台词。" } },
				},
			},
		},
		async run(args, callerSignal): Promise<ToolExecutionResult> {
			if (typeof args.text !== "string" || !args.text.trim()) {
				return { status: "not_started", result: "未生成：text 必须包含台词。" };
			}
			const deadline = new AbortController();
			const signal = AbortSignal.any([
				deadline.signal,
				...[callerSignal, options.signal].filter((s): s is AbortSignal => !!s),
			]);
			const timer = setTimeout(() => deadline.abort(new Error("生成超时")), timeoutMs);
			try {
				signal.throwIfAborted();
				const audio = await abortable(options.client.generate(args.text, timeoutMs, signal), signal);
				return await publishWav(outputDir, audio, signal);
			} catch (error) {
				let status: ToolExecutionResult["status"] = "failed";
				let message = error instanceof TtsGenerationError ? error.message : "TTS 生成失败，请检查 tts inspect";
				const cause = error instanceof TtsGenerationError ? error.cause : undefined;
				const aborted =
					signal.aborted &&
					(error === signal.reason ||
						(typeof cause === "object" &&
							cause !== null &&
							"abortReason" in cause &&
							cause.abortReason === signal.reason));
				if (aborted) {
					if (signal.reason === deadline.signal.reason) message = "生成超时";
					else {
						status = "cancelled";
						message = "已取消";
					}
				}
				const details =
					error instanceof Error
						? { error: error.message, cause: error.cause instanceof Error ? String(error.cause) : error.cause }
						: { error: String(error) };
				return { status, result: `${message}，未生成文件。`, details };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
