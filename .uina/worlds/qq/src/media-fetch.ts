import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { ImageContent } from "../../../../src/core/content.js";
import type { MessageFact } from "./types.js";
import { decodeOneBotSegments, oneBotId } from "./message-codec.js";

/**
 * 入站媒体展开（单一 owner）：收集 inbound image 段 → 抓取 base64 →
 * 附加到 ToolExecutionResult.images 走 runtime 的 tool-role 图片通道。
 * 边界：仅 image 段；逐段失败不阻断（结果文本保留"未展开"事实）；音视频不转写。
 * URL 可能过期（rkey/缓存淘汰），失败如实报告，不伪造内容。
 */

const MAX_IMAGES = 4;
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type AllowedMime = (typeof ALLOWED_MIME)[number];

export interface InboundImageSource {
	readonly messageRef?: string;
	readonly segmentIndex?: number;
	readonly forwardNodeIndex?: number;
	readonly nodeSegmentIndex?: number;
	readonly mediaRef?: string;
	readonly url?: string;
	readonly fileName?: string;
	readonly alt?: string;
}

export interface FetchFailure {
	readonly messageRef?: string;
	readonly segmentIndex?: number;
	readonly forwardNodeIndex?: number;
	readonly nodeSegmentIndex?: number;
	readonly mediaRef?: string;
	readonly fileName?: string;
	readonly reason: string;
}

export interface FetchedImages {
	readonly images: ImageContent[];
	readonly failures: readonly FetchFailure[];
	readonly successes: readonly InboundImageSource[];
}

function sniffMime(bytes: Uint8Array): AllowedMime | null {
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return "image/png";
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45
	)
		return "image/webp";
	return null;
}

function headerMime(contentType: string | null): AllowedMime | null {
	if (!contentType) return null;
	const mime = contentType.split(";")[0]!.trim().toLowerCase();
	return (ALLOWED_MIME as readonly string[]).includes(mime) ? (mime as AllowedMime) : null;
}

/** 抓取图片段列表；超过 MAX_IMAGES 截断并计入 failures（不做静默丢弃）。 */
export async function fetchInboundImages(
	sources: readonly InboundImageSource[],
	signal?: AbortSignal,
): Promise<FetchedImages> {
	const images: ImageContent[] = [];
	const failures: FetchFailure[] = [];
	const successes: InboundImageSource[] = [];
	function recordFailure(source: InboundImageSource, reason: string): void {
		failures.push({
			messageRef: source.messageRef,
			segmentIndex: source.segmentIndex,
			forwardNodeIndex: source.forwardNodeIndex,
			nodeSegmentIndex: source.nodeSegmentIndex,
			mediaRef: source.mediaRef,
			fileName: source.fileName,
			reason,
		});
	}

	for (const [index, source] of sources.entries()) {
		if (signal?.aborted) {
			recordFailure(source, "展开已取消");
			continue;
		}
		if (index >= MAX_IMAGES) {
			recordFailure(source, `超出单次展开上限（${MAX_IMAGES} 张）`);
			continue;
		}
		if (!source.url || !/^https?:\/\//i.test(source.url)) {
			recordFailure(source, "无可用的平台 HTTP(S) 地址");
			continue;
		}
		try {
			const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
			const response = await fetch(source.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
			if (!response.ok) {
				recordFailure(source, `HTTP ${response.status}（URL 可能已过期）`);
				continue;
			}
			// content-length 预检：超限不全量下载；无声明时退回读后校验。
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > MAX_BYTES) {
				recordFailure(source, `超出单张大小上限（${MAX_BYTES} 字节）`);
				continue;
			}
			const buffer = new Uint8Array(await response.arrayBuffer());
			if (buffer.byteLength > MAX_BYTES) {
				recordFailure(source, `超出单张大小上限（${MAX_BYTES} 字节）`);
				continue;
			}
			const mime = headerMime(response.headers.get("content-type")) ?? sniffMime(buffer);
			if (!mime) {
				recordFailure(source, "内容不是可识别的图片格式");
				continue;
			}
			images.push({
				type: "image",
				mimeType: mime,
				data: Buffer.from(buffer).toString("base64"),
				alt: imageSourceLabel(source),
			});
			successes.push(source);
		} catch (error) {
			recordFailure(source, error instanceof Error ? error.message : String(error));
		}
	}
	return { images, failures, successes };
}

/* ---------- 来源收集（journal 事实 / OneBot 原始历史）与结果装配 ---------- */

/** 从入站事实收集 image 段。 */
export function imageSourcesFromFacts(facts: readonly MessageFact[]): InboundImageSource[] {
	return facts.flatMap((fact) =>
		fact.segments.flatMap((seg, segmentIndex) => {
			if (seg.type !== "image") return [];
			const source = {
				messageRef: fact.ref,
				segmentIndex,
				mediaRef: seg.mediaRef,
				url: seg.url,
				fileName: seg.fileName,
			};
			return [{ ...source, alt: imageSourceLabel(source) }];
		}),
	);
}

/** 从 OneBot 原始消息数组收集 image 段（平台历史页用）。 */
export function imageSourcesFromOneBot(messages: readonly Record<string, unknown>[]): InboundImageSource[] {
	const sources: InboundImageSource[] = [];
	for (const message of messages) {
		const id = oneBotId(message.message_id, true);
		const decoded = decodeOneBotSegments(message.message ?? message.raw_message);
		decoded.segments.forEach((seg, segmentIndex) => {
			if (seg.type !== "image") return;
			const source = {
				messageRef: id ? `m${id}` : undefined,
				segmentIndex,
				mediaRef: seg.mediaRef,
				url: seg.url,
				fileName: seg.fileName,
			};
			sources.push({ ...source, alt: imageSourceLabel(source) });
		});
	}
	return sources;
}

function imageSourceLabel(
	source: Pick<
		InboundImageSource,
		"messageRef" | "segmentIndex" | "mediaRef" | "fileName" | "forwardNodeIndex" | "nodeSegmentIndex" | "alt"
	>,
): string {
	const coordinates = `messageRef=${source.messageRef ?? "unknown"} segmentIndex=${source.segmentIndex ?? "unknown"} mediaRef=${source.mediaRef ?? "-"}${source.forwardNodeIndex === undefined ? "" : ` forwardNodeIndex=${source.forwardNodeIndex}`}${source.nodeSegmentIndex === undefined ? "" : ` nodeSegmentIndex=${source.nodeSegmentIndex}`}${source.fileName ? ` file=${JSON.stringify(source.fileName)}` : ""}`;
	return source.alt && source.alt !== coordinates ? `${coordinates} label=${JSON.stringify(source.alt)}` : coordinates;
}

/** 抓取并生成结果附加行；失败逐条列出（不阻断、不伪造）。 */
export async function expandImages(
	sources: readonly InboundImageSource[],
	signal?: AbortSignal,
): Promise<{ note: string; images: ImageContent[] }> {
	if (sources.length === 0) return { note: "", images: [] };
	const fetched = await fetchInboundImages(sources, signal);
	const lines = [`media=请求展开 ${sources.length} 张：成功 ${fetched.images.length}，失败 ${fetched.failures.length}`];
	for (const success of fetched.successes) lines.push(`  成功 ${imageSourceLabel(success)}：已附加图片`);
	for (const failure of fetched.failures) {
		lines.push(`  失败 ${imageSourceLabel(failure)}：${JSON.stringify(failure.reason)}`);
	}
	return { note: lines.join("\n"), images: fetched.images };
}

/** 把展开图片附加到成功结果（ToolExecutionResult.images 走 tool-role 图片通道）。 */
export function withImages(result: ToolExecutionResult, images: readonly ImageContent[]): ToolExecutionResult {
	return images.length > 0 ? { ...result, images: [...images] } : result;
}
