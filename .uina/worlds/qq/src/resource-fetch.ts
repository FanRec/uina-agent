import { createHash, randomUUID } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";
import { parseFileReference, readFileDirectory } from "./discovery.js";
import { assertPlatformIdentity, assertQueryActive, QueryError, queryPlatform } from "./platform-query.js";
import { decodeOneBotMessage, oneBotObject } from "./message-codec.js";
import { readMessage } from "./observe.js";
import {
	parseConversationRef,
	parseMessageRef,
	REF_PATTERNS,
	sameAttachment,
	type MediaFact,
	type MessageFact,
} from "./types.js";

/** Only this downloader's unpublished directories; published resources survive restarts. */
export function cleanupPartialDownloads(dataDir: string): void {
	const root = join(dataDir, "downloads");
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		if (!/^\.partial-[A-Za-z0-9]{6}$/.test(name)) continue;
		const path = join(root, name);
		if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
	}
}

function mediaFromMessage(fact: MessageFact, index: number): MediaFact {
	const segment = fact.segments[index];
	if (!segment || !["file", "image", "audio", "video"].includes(segment.type))
		throw new QueryError("locator_unavailable", "所选分段不是可拉取附件。");
	const media = segment as Extract<MessageFact["segments"][number], { type: "image" | "audio" | "video" | "file" }>;
	return {
		type: media.type,
		url: media.url,
		fileName: media.fileName,
		locator: media.locator,
		origin: { messageRef: fact.ref, conversationRef: fact.conversationRef, segmentIndex: index },
	};
}

function httpUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

async function mediaAddress(deps: QqAppDeps, media: MediaFact, signal?: AbortSignal): Promise<string> {
	const savedUrl = httpUrl(media.url);
	if (savedUrl) return savedUrl;
	const locator = media.locator;
	const conv = media.origin && parseConversationRef(media.origin.conversationRef);
	let action: string;
	let params: Record<string, unknown>;
	if (media.type === "file" && conv?.kind === "group" && locator?.fileId) {
		action = "get_group_file_url";
		params = {
			group_id: conv.key,
			file_id: locator.fileId,
			...(locator.busid !== undefined ? { busid: locator.busid } : {}),
		};
	} else if (media.type === "file" && conv?.kind === "private" && locator?.fileId && locator.fileHash) {
		action = "get_private_file_url";
		params = { user_id: conv.key, file_id: locator.fileId, file_hash: locator.fileHash };
	} else if (media.type !== "file" && (locator?.file || locator?.fileId)) {
		switch (media.type) {
			case "image":
				action = "get_image";
				break;
			case "audio":
				action = "get_record";
				break;
			case "video":
				action = "get_file";
				break;
		}
		params = {
			...(locator.file ? { file: locator.file } : {}),
			...(locator.fileId ? { file_id: locator.fileId } : {}),
		};
	} else throw new QueryError("locator_unavailable", "附件缺少平台读取定位，不能推测下载地址。");
	const raw = await queryPlatform(deps, action, params, signal);
	const data = oneBotObject(raw);
	const url = httpUrl(data?.url) ?? httpUrl(data?.file);
	if (!url)
		throw new QueryError(
			"resource_unavailable",
			"平台未返回可拉取的 HTTP(S) 资源；平台本地路径没有共享映射，不能冒充 Uina 本地文件。",
		);
	return url;
}

async function refreshMedia(
	deps: QqAppDeps,
	media: MediaFact,
	ref: string | undefined,
	signal?: AbortSignal,
): Promise<MediaFact> {
	if (!media.origin) throw new QueryError("locator_unavailable", "旧附件没有可刷新来源。");
	if (media.origin.forwardNodeIndex !== undefined)
		throw new QueryError("resource_unavailable", "转发附件地址已过期；请重新 browse 转发节点获取引用。");
	const raw = await queryPlatform(
		deps,
		"get_msg",
		{ message_id: parseMessageRef(media.origin.messageRef)!.messageId },
		signal,
	);
	const fact = decodeOneBotMessage(raw, deps.selfId);
	if (!fact || fact.ref !== media.origin.messageRef || fact.conversationRef !== media.origin.conversationRef)
		throw new QueryError("resource_unavailable", "平台返回消息与原附件来源不符。");
	const refreshed = mediaFromMessage(fact, media.origin.segmentIndex);
	if (!sameAttachment(media, refreshed))
		throw new QueryError("resource_unavailable", "刷新后的附件身份或类型发生变化。");
	assertQueryActive(deps, signal);
	try {
		deps.journal.saveMediaLocator(ref, refreshed);
	} catch {
		throw new QueryError("storage_failed", "附件定位证据写入失败。");
	}
	return refreshed;
}

function safeName(value: string | undefined): string {
	const name = (value ?? "resource.bin")
		.split(/[\\/]/)
		.at(-1)!
		.replace(/[<>:"|?*\x00-\x1f]/g, "_")
		.replace(/[. ]+$/g, "")
		.slice(0, 120);
	return !name || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name) ? "resource.bin" : name;
}

function sniffMime(bytes: Buffer): string | null {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
	if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
	if (bytes.toString("ascii", 0, 4) === "OggS") return "application/ogg";
	if (bytes.subarray(0, 16).toString("ascii").includes("#!SILK_V3")) return "audio/silk";
	if (bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
	return null;
}

interface DownloadSource {
	readonly media: MediaFact;
	readonly origin: Record<string, unknown>;
	readonly expectedSize: number | null;
}

/** Owns the unpublished directory until bytes and provenance can be published together. */
async function publishDownload(
	deps: QqAppDeps,
	response: Response,
	source: DownloadSource,
	signal: AbortSignal,
): Promise<ToolExecutionResult> {
	const { media, origin, expectedSize } = source;
	const downloadSignal = signal;
	if (!response.body) throw new QueryError("download_failed", "平台资源没有字节流。");
	let temporary: string | undefined;
	try {
		const root = join(deps.journal.dataDir, "downloads");
		try {
			mkdirSync(root, { recursive: true });
			temporary = mkdtempSync(join(root, ".partial-"));
		} catch {
			await response.body.cancel();
			throw new QueryError("storage_failed", "下载目录无法写入。");
		}
		const name = safeName(media.fileName);
		const storedName = `payload-${name}`;
		const hash = createHash("sha256");
		let size = 0;
		let prefix = Buffer.alloc(0);
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				size += chunk.length;
				hash.update(chunk);
				if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
				callback(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
			counter,
			createWriteStream(join(temporary, storedName), { flags: "wx" }),
			{ signal: downloadSignal },
		);
		const declared = response.headers.get("content-length");
		const encoded = response.headers.get("content-encoding");
		const length =
			declared !== null && /^\d+$/.test(declared) && (!encoded || encoded === "identity") ? Number(declared) : null;
		if ((length !== null && size !== length) || (expectedSize !== null && size !== expectedSize))
			throw new QueryError("integrity_mismatch", "资源实际大小与传输/目录证据不符。");
		const sha256 = hash.digest("hex");
		const result = {
			fileName: name,
			mediaType: media.type,
			mimeType: sniffMime(prefix),
			declaredMimeType: response.headers.get("content-type")?.split(";")[0] ?? null,
			sizeBytes: size,
			sha256,
			integrity: length !== null || expectedSize !== null ? "transport_checked" : "local_digest_only",
			fetchedAt: deps.now?.() ?? new Date().toISOString(),
			source: "platform",
			origin,
		};
		assertQueryActive(deps, downloadSignal);
		assertPlatformIdentity(deps);
		const destination = join(root, randomUUID());
		try {
			writeFileSync(join(temporary, "origin.json"), JSON.stringify(result), { flag: "wx" });
			renameSync(temporary, destination);
		} catch {
			throw new QueryError("storage_failed", "文件与来源元数据发布失败。");
		}
		temporary = undefined;
		const resource = { kind: "file", path: join(destination, storedName) };
		return worldSucceeded(
			`[QQ fetch] 已取得 ${name}（${size} 字节）；${JSON.stringify(resource)}\n未解析或转写内容。`,
			{ ...result, resource },
		);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			["EACCES", "EDQUOT", "ENOSPC", "EIO", "EPERM", "EROFS"].includes(String(error.code))
		)
			throw new QueryError("storage_failed", "资源无法完整写入本地文件，未发布成果。");
		throw error;
	} finally {
		if (temporary) rmSync(temporary, { recursive: true, force: true });
	}
}

export async function handleFetch(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	assertQueryActive(deps, signal);
	assertPlatformIdentity(deps);
	const target = oneBotObject(params.target);
	if (
		!target ||
		[target.mediaRef, target.fileRef, target.messageRef].filter((value) => value !== undefined).length !== 1
	)
		throw new QueryError("invalid_params", "fetch.target 必须明确选择一个附件引用或消息分段。");
	let media: MediaFact;
	let ref: string | undefined;
	let origin: Record<string, unknown>;
	let expectedSize: number | null = null;
	let locate: (signal?: AbortSignal) => Promise<string>;
	if (target.fileRef !== undefined) {
		const locator = parseFileReference(target.fileRef, "file", deps.selfId);
		media = { type: "file" };
		origin = { fileRef: target.fileRef, conversationRef: locator.conversationRef };
		locate = async (signal) => {
			const directory = await readFileDirectory(deps, locator.conversationRef, locator.folderId, signal);
			const file = directory.find(
				(item) =>
					item.kind === "file" && parseFileReference(item.fileRef, "file", deps.selfId).fileId === locator.fileId,
			);
			if (!file) throw new QueryError("resource_unavailable", "文件已不在原目录中，未以同名文件替换。");
			const current = parseFileReference(file.fileRef, "file", deps.selfId);
			media = { type: "file", fileName: file.name as string };
			expectedSize = file.sizeBytes as number | null;
			const data = oneBotObject(
				await queryPlatform(
					deps,
					"get_group_file_url",
					{
						group_id: current.conversationRef.slice(1),
						file_id: current.fileId,
						...(current.busid !== undefined ? { busid: current.busid } : {}),
					},
					signal,
				),
			);
			const url = httpUrl(data?.url);
			if (!url) throw new QueryError("resource_unavailable", "群文件没有可用平台下载地址。");
			return url;
		};
	} else {
		if (target.mediaRef !== undefined) {
			if (typeof target.mediaRef !== "string" || !REF_PATTERNS.media.test(target.mediaRef))
				throw new QueryError("invalid_reference", "mediaRef 非法。");
			ref = target.mediaRef;
			const saved = deps.journal.getMedia(ref);
			if (!saved) throw new QueryError("resource_unavailable", "该账号没有此附件引用。");
			media = saved;
		} else {
			if (
				typeof target.messageRef !== "string" ||
				!parseMessageRef(target.messageRef) ||
				typeof target.segmentIndex !== "number" ||
				!Number.isSafeInteger(target.segmentIndex) ||
				target.segmentIndex < 0
			)
				throw new QueryError("invalid_params", "消息拉取必须提供有效 messageRef 和非负 segmentIndex。");
			const fact = await readMessage(deps, target.messageRef, signal);
			assertQueryActive(deps, signal);
			assertPlatformIdentity(deps);
			if (!fact) throw new QueryError("resource_unavailable", "原消息不可用。");
			media = mediaFromMessage(fact, target.segmentIndex);
			const segment = fact.segments[target.segmentIndex]!;
			ref = "mediaRef" in segment ? segment.mediaRef : undefined;
			const saved = ref ? deps.journal.getMedia(ref) : null;
			if (saved && sameAttachment(media, saved)) media = saved;
		}
		if (!media.url && !media.locator?.file && !media.locator?.fileId)
			media = await refreshMedia(deps, media, ref, signal);
		assertQueryActive(deps, signal);
		try {
			ref = deps.journal.saveMediaLocator(ref, media);
		} catch {
			throw new QueryError("storage_failed", "附件定位证据写入失败。");
		}
		origin = { mediaRef: ref, ...media.origin };
		locate = (signal) => mediaAddress(deps, media, signal);
	}
	let url = await locate(signal);
	assertQueryActive(deps, signal);
	assertPlatformIdentity(deps);
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), deps.requestTimeoutMs ?? 10_000);
	const downloadSignal = AbortSignal.any([
		deadline.signal,
		...(signal ? [signal] : []),
		...(deps.signal ? [deps.signal] : []),
	]);
	try {
		let response = await fetch(url, { signal: downloadSignal });
		if ([401, 403, 404].includes(response.status)) {
			await response.body?.cancel();
			if (target.fileRef === undefined) media = await refreshMedia(deps, media, ref, downloadSignal);
			url = await locate(downloadSignal);
			response = await fetch(url, { signal: downloadSignal });
		}
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new QueryError("download_failed", `平台资源读取失败（HTTP ${response.status}）。`);
		}
		assertQueryActive(deps, downloadSignal);
		return await publishDownload(deps, response, { media, origin, expectedSize }, downloadSignal);
	} catch (error) {
		if (signal?.aborted || deps.signal?.aborted) throw error;
		if (deadline.signal.aborted)
			throw new QueryError("download_timeout", "资源拉取超过 connection.requestTimeoutMs，可主动重试。");
		if (error instanceof QueryError) throw error;
		throw new QueryError("download_failed", "资源字节读取或本地写入未能完成，未发布文件。");
	} finally {
		clearTimeout(timer);
	}
}
