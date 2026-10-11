import { createHash } from "node:crypto";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";
import { oneBotId, oneBotObject, oneBotTime } from "./message-codec.js";
import { paginate } from "./pagination.js";
import { REF_PATTERNS } from "./types.js";
import { QueryError, queryPlatform } from "./platform-query.js";

function malformed(message: string): never {
	throw new QueryError("malformed_response", message);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalized(value: string): string {
	return value.normalize("NFC").toLowerCase();
}

function matches(query: unknown, fields: readonly (string | null)[]): boolean {
	const needle = normalized(typeof query === "string" ? query.trim() : "");
	return !needle || fields.some((field) => field !== null && normalized(field).includes(needle));
}

function compareId(a: string, b: string): number {
	return a.length - b.length || a.localeCompare(b, "en");
}

function listResult(
	deps: QqAppDeps,
	action: string,
	params: Record<string, unknown>,
	items: Record<string, unknown>[],
	details: Record<string, unknown>,
): ToolExecutionResult {
	const { cursor: _cursor, ...conditions } = params;
	const page = paginate(items, params, { account: deps.selfId, action, ...conditions });
	if (!page.ok) return worldFailed(page.detail, { reason: page.reason, restartCall: { action, params: conditions } });
	const nextCall = page.nextCursor ? { action, params: { ...conditions, cursor: page.nextCursor } } : undefined;
	const visible = page.page.map(({ contentDigest: _digest, sequence: _sequence, ...item }) => item);
	const text = [
		`[QQ ${action}] source=${details.source}；本页 ${page.page.length}/${page.total}`,
		...visible.map((item) =>
			action === "expressions"
				? `id=${item.faceId ?? item.reactionCode} | ${JSON.stringify(item)}`
				: JSON.stringify(item),
		),
		`hasMore=${page.hasMore}${nextCall ? `；续页：${JSON.stringify(nextCall)}` : ""}`,
	];
	if (details.coverage) text.push(`范围：${JSON.stringify(details.coverage)}`);
	if (action === "expressions")
		text.push("faceId/reactionCode 只接受平台数字编码，不能把 Unicode emoji 当作数字编码；复制返回编码用于对应调用。");
	return worldSucceeded(text.join("\n"), {
		...details,
		observedAt: deps.now?.() ?? new Date().toISOString(),
		items: visible,
		total: page.total,
		count: page.page.length,
		hasMore: page.hasMore,
		...(nextCall ? { nextCursor: page.nextCursor, nextCall } : {}),
	});
}

function groupId(ref: unknown): string {
	if (typeof ref !== "string" || !REF_PATTERNS.groupConversation.test(ref))
		throw new QueryError("invalid_params", "conversationRef 必须是群引用。");
	return ref.slice(1);
}

export async function handlePeople(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const scope = params.scope ?? "friends";
	if (scope !== "friends" && scope !== "members" && scope !== "person")
		throw new QueryError("invalid_params", "people.scope 必须是 friends/members/person。");
	const group = scope === "members" || params.conversationRef !== undefined ? groupId(params.conversationRef) : null;
	if (scope === "friends" && group) throw new QueryError("invalid_params", "friends 不接受群上下文。");
	let data: unknown;
	if (scope === "person") {
		if (typeof params.userRef !== "string" || !REF_PATTERNS.user.test(params.userRef))
			throw new QueryError("invalid_params", "person 必须提供 userRef。");
		data = await queryPlatform(
			deps,
			group ? "get_group_member_info" : "get_stranger_info",
			{
				user_id: params.userRef.slice(1),
				...(group ? { group_id: group, no_cache: true } : {}),
			},
			signal,
		);
	} else {
		data = await queryPlatform(
			deps,
			group ? "get_group_member_list" : "get_friend_list",
			group ? { group_id: group, no_cache: true } : {},
			signal,
		);
		if (!Array.isArray(data)) malformed("人物列表应为数组，不能作为空目录处理。");
	}
	const rows = scope === "person" ? [data] : (data as unknown[]);
	const items = rows
		.map((raw) => {
			const row = oneBotObject(raw);
			const id = oneBotId(row?.user_id);
			if (!row || !id) malformed("人物条目缺少有效 user_id。");
			if (scope === "person" && `u${id}` !== params.userRef) malformed("人物回执身份与请求不符。");
			if (row.group_id !== undefined && oneBotId(row.group_id) !== group) malformed("成员回执群身份与请求不符。");
			const nickname = stringOrNull(row.nickname);
			const remark = stringOrNull(row.remark);
			const card = stringOrNull(row.card);
			const name = (group ? card : remark) ?? nickname;
			return {
				userRef: `u${id}`,
				displayName: name ?? `u${id}`,
				nickname,
				remark,
				card,
				role: group ? stringOrNull(row.role) : null,
				...(group ? { conversationRef: `g${group}` } : {}),
				nameUnknown: name === null,
			};
		})
		.filter((item) => matches(params.query, [item.nickname, item.remark, item.card]));
	items.sort((a, b) => compareId(a.userRef.slice(1), b.userRef.slice(1)));
	const details = {
		source: "platform",
		coverage: { scope, cacheFreshness: "unknown", platformCompleteness: "unknown", onlineStatus: "unknown" },
	};
	if (scope === "person")
		return worldSucceeded(JSON.stringify(items[0]), {
			...details,
			observedAt: deps.now?.() ?? new Date().toISOString(),
			person: items[0],
		});
	return listResult(deps, "people", { ...params, scope }, items, details);
}

export async function handleExpressions(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const kind = params.kind ?? "face";
	if (kind !== "face" && kind !== "reaction")
		throw new QueryError("invalid_kind", "expressions.kind 必须是 face/reaction。");
	const query = typeof params.query === "string" ? params.query.trim() : "";
	const data = oneBotObject(
		await queryPlatform(deps, query ? "search_sys_faces" : "fetch_sys_faces", query ? { query } : {}, signal),
	);
	if (!data) malformed("系统表情返回不是目录对象。");
	let raw: unknown[];
	if (query) {
		if (!Array.isArray(data.faces)) malformed("系统表情查询缺少 faces 数组。");
		raw = data.faces;
	} else {
		if (!Array.isArray(data.packs)) malformed("系统表情目录缺少 packs 数组。");
		raw = data.packs.flatMap((value) => {
			const pack = oneBotObject(value);
			if (!pack || !Array.isArray(pack.emojis)) malformed("系统表情包缺少 emojis 数组。");
			return pack.emojis;
		});
	}
	const seen = new Set<string>();
	const items = raw.flatMap((value) => {
		const row = oneBotObject(value);
		const code = row?.q_sid;
		if (typeof code !== "string" || !/^(0|[1-9]\d*)$/.test(code) || !Number.isSafeInteger(Number(code)))
			malformed("系统表情缺少合法数字 q_sid。");
		if (seen.has(code)) return [];
		seen.add(code);
		const name = stringOrNull(row?.q_des);
		return [
			{
				...(kind === "face" ? { faceId: code } : { reactionCode: code }),
				name,
				aliases:
					Array.isArray(row?.emoji_name_alias) && row.emoji_name_alias.every((alias) => typeof alias === "string")
						? row.emoji_name_alias
						: null,
				isSuper: typeof row?.is_super === "boolean" ? row.is_super : null,
				template:
					kind === "face"
						? {
								action: "send",
								params: { content: [{ type: "face", faceId: code }] },
								requiredFields: ["conversationRef"],
							}
						: { action: "interact", params: { action: "react", reactionCode: code }, requiredFields: ["messageRef"] },
			},
		];
	});
	items.sort((a, b) => compareId("faceId" in a ? a.faceId : a.reactionCode, "faceId" in b ? b.faceId : b.reactionCode));
	const result = listResult(deps, "expressions", { ...params, kind, query }, items, {
		source: "platform",
		coverage: { scope: "system", targetAcceptance: "unknown", platformCompleteness: "unknown" },
	});
	if (result.status === "succeeded")
		for (const item of items) {
			const code = "faceId" in item ? item.faceId : item.reactionCode;
			if (item.name) deps.faceNames?.set(code, item.name);
		}
	return result;
}

export interface FileLocator {
	account: string;
	conversationRef: string;
	folderId: string | null;
	fileId?: string;
	busid?: number;
}

export function fileReference(kind: "file" | "folder", locator: FileLocator): string {
	return `q${kind}:v1:${Buffer.from(JSON.stringify(locator)).toString("base64url")}`;
}

export function parseFileReference(ref: unknown, kind: "file" | "folder", selfId: string): FileLocator {
	if (typeof ref !== "string" || !ref.startsWith(`q${kind}:v1:`))
		throw new QueryError("invalid_reference", "文件引用格式或版本非法。");
	let value: Record<string, unknown> | null = null;
	try {
		const encoded = ref.slice(`q${kind}:v1:`.length);
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new Error("Non-canonical reference");
		value = oneBotObject(JSON.parse(bytes.toString("utf8")));
	} catch {
		/* invalid reference */
	}
	if (
		!value ||
		typeof value.account !== "string" ||
		typeof value.conversationRef !== "string" ||
		!REF_PATTERNS.groupConversation.test(value.conversationRef) ||
		(value.folderId !== null && (typeof value.folderId !== "string" || !value.folderId)) ||
		(kind === "folder" && !value.folderId) ||
		(kind === "file" && (typeof value.fileId !== "string" || !value.fileId)) ||
		(value.busid !== undefined &&
			(typeof value.busid !== "number" || !Number.isSafeInteger(value.busid) || value.busid < 0))
	)
		throw new QueryError("invalid_reference", "文件引用缺少有效平台定位。");
	if (value.account !== selfId) throw new QueryError("account_mismatch", "文件引用属于其他绑定账号。");
	return {
		account: value.account,
		conversationRef: value.conversationRef,
		folderId: value.folderId as string | null,
		...(kind === "file" ? { fileId: value.fileId as string } : {}),
		...(value.busid !== undefined ? { busid: value.busid as number } : {}),
	};
}

function nonnegative(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function readFileDirectory(
	deps: QqAppDeps,
	conversationRef: string,
	folderId: string | null,
	signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
	const group = groupId(conversationRef);
	const raw = oneBotObject(
		await queryPlatform(
			deps,
			folderId ? "get_group_files_by_folder" : "get_group_root_files",
			{ group_id: group, ...(folderId ? { folder_id: folderId } : {}) },
			signal,
		),
	);
	if (!raw || !Array.isArray(raw.files) || !Array.isArray(raw.folders))
		malformed("群文件目录必须包含 files/folders 数组。");
	if (raw.has_more === true || raw.next_cursor || raw.nextCursor)
		throw new QueryError("directory_incomplete", "平台目录返回续页信号，当前适配链路尚不能完整枚举，未冒充完整目录。");
	const parentFolderRef = folderId
		? fileReference("folder", { account: deps.selfId, conversationRef, folderId })
		: null;
	const folders = raw.folders.map((value) => {
		const row = oneBotObject(value);
		const id = stringOrNull(row?.folder_id ?? row?.id);
		const name = stringOrNull(row?.folder_name ?? row?.name);
		if (!id || !name) malformed("群文件夹缺少身份或名称。");
		return {
			kind: "folder",
			folderRef: fileReference("folder", { account: deps.selfId, conversationRef, folderId: id }),
			name,
			parentFolderRef,
			knownChildCount: nonnegative(row?.total_file_count),
		};
	});
	const files = raw.files.map((value) => {
		const row = oneBotObject(value);
		const id = stringOrNull(row?.file_id ?? row?.id);
		const name = stringOrNull(row?.file_name ?? row?.name);
		if (!id || !name) malformed("群文件缺少身份或名称。");
		const busid = nonnegative(row?.busid);
		return {
			kind: "file",
			fileRef: fileReference("file", {
				account: deps.selfId,
				conversationRef,
				folderId,
				fileId: id,
				...(busid !== null ? { busid } : {}),
			}),
			name,
			parentFolderRef,
			sizeBytes: nonnegative(row?.file_size ?? row?.size),
			uploaderRef: oneBotId(row?.uploader ?? row?.uploader_id)
				? `u${oneBotId(row?.uploader ?? row?.uploader_id)}`
				: null,
			uploadedAt: oneBotTime(row?.upload_time ?? row?.create_time),
		};
	});
	return [...folders, ...files].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		return (
			a.name.normalize("NFC").localeCompare(b.name.normalize("NFC"), "en") ||
			JSON.stringify(a).localeCompare(JSON.stringify(b), "en")
		);
	});
}

export async function handleFiles(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	groupId(params.conversationRef);
	const conv = params.conversationRef as string;
	const folder = params.folderRef === undefined ? null : parseFileReference(params.folderRef, "folder", deps.selfId);
	if (folder && folder.conversationRef !== conv) throw new QueryError("account_mismatch", "文件夹引用不属于所查询群。");
	const items = (await readFileDirectory(deps, conv, folder?.folderId ?? null, signal))
		.filter((item) => matches(params.query, [item.name as string]))
		.map((item) => ({
			...item,
			nextCall:
				item.kind === "file"
					? { action: "fetch", params: { target: { fileRef: item.fileRef } } }
					: { action: "files", params: { conversationRef: conv, folderRef: item.folderRef } },
		}));
	return listResult(deps, "files", params, items, {
		source: "platform",
		coverage: {
			conversationRef: conv,
			folderRef: params.folderRef ?? null,
			recursive: false,
			directoryComplete: null,
			platformCompleteness: "unknown",
		},
	});
}

export function handleSearch(deps: QqAppDeps, params: Record<string, unknown>): ToolExecutionResult {
	if (params.source !== undefined && params.source !== "local")
		throw new QueryError("invalid_params", "search 仅检索 local 已收录历史。");
	const query = typeof params.query === "string" ? params.query.trim() : "";
	if (!query) throw new QueryError("invalid_params", "search.query 必须是非空字面关键词。");
	const timeBound = (value: unknown): number | null => {
		if (value === undefined) return null;
		if (
			typeof value !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
			!Number.isFinite(Date.parse(value))
		)
			throw new QueryError("invalid_params", "时间范围必须是带时区的有效 ISO 时间。");
		return Date.parse(value);
	};
	const since = timeBound(params.since);
	const until = timeBound(params.until);
	if (since !== null && until !== null && since >= until)
		throw new QueryError("invalid_params", "since 必须早于 until。");
	const conversations = [...deps.journal.snapshot.messages.keys()]
		.filter((ref) => !params.conversationRef || ref === params.conversationRef)
		.sort();
	const facts = [
		...new Map(
			conversations.flatMap((ref) => deps.journal.snapshot.messages.get(ref) ?? []).map((fact) => [fact.ref, fact]),
		).values(),
	];
	const recalled = new Set(
		[...deps.journal.snapshot.events.values(), deps.journal.snapshot.accountEvents]
			.flat()
			.filter((event) => event.kind === "recall")
			.map((event) => event.messageRef),
	);
	let excludedUnknownTime = 0;
	const archiveTime = deps.journal.snapshot.archiveBefore ? Date.parse(deps.journal.snapshot.archiveBefore) : NaN;
	const needle = normalized(query);
	const items = facts
		.filter((fact) => {
			if (params.senderRef && fact.senderRef !== params.senderRef) return false;
			if (params.direction && fact.direction !== params.direction) return false;
			const time = Date.parse(fact.time);
			if ((since !== null || until !== null) && !Number.isFinite(time)) {
				excludedUnknownTime++;
				return false;
			}
			return (since === null || time >= since) && (until === null || time < until);
		})
		.flatMap((fact) => {
			const fields = fact.segments.flatMap((segment, segmentIndex) => {
				let field: "text" | "fileName";
				let text: string;
				if (segment.type === "text") {
					field = "text";
					text = segment.text;
				} else if ("fileName" in segment && segment.fileName) {
					field = "fileName";
					text = segment.fileName;
				} else return [];
				const nfc = text.normalize("NFC");
				const hit = nfc.toLowerCase().indexOf(needle);
				if (hit < 0) return [];
				// Lowercasing can expand a character (e.g. İ); map the hit back to the displayed text.
				let offset = 0;
				let foldedOffset = 0;
				for (const point of nfc) {
					if (foldedOffset >= hit) break;
					offset += point.length;
					foldedOffset += point.toLowerCase().length;
				}
				const start = Math.max(0, offset - 80);
				return [
					{
						field,
						segmentIndex,
						text: nfc.slice(start, start + 400),
						truncated: start > 0 || start + 400 < nfc.length,
					},
				];
			});
			if (!fields.length) return [];
			return [
				{
					messageRef: fact.ref,
					conversationRef: fact.conversationRef,
					senderRef: fact.senderRef,
					senderDisplayName: fact.senderDisplayName,
					time: Number.isFinite(Date.parse(fact.time)) ? fact.time : null,
					direction: fact.direction,
					sequence: fact.sequence,
					recalled: recalled.has(fact.ref),
					archived: Date.parse(fact.time) < archiveTime,
					snippets: fields,
					contentDigest: createHash("sha256").update(JSON.stringify(fact.segments)).digest("hex"),
					nextCall: { action: "browse", params: { messageRefs: [fact.ref] } },
				},
			];
		});
	items.sort(
		(a, b) =>
			(b.time === null ? -Infinity : Date.parse(b.time)) - (a.time === null ? -Infinity : Date.parse(a.time)) ||
			a.conversationRef.localeCompare(b.conversationRef, "en") ||
			b.sequence - a.sequence ||
			a.messageRef.localeCompare(b.messageRef, "en"),
	);
	const times = facts
		.map((fact) => Date.parse(fact.time))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const coverage = {
		description: "仅检索本地已收录历史；无命中不代表平台上不存在。",
		conversations,
		collectedCount: facts.length,
		earliest: times.length ? new Date(times[0]!).toISOString() : null,
		latest: times.length ? new Date(times.at(-1)!).toISOString() : null,
		since: params.since ?? null,
		until: params.until ?? null,
		excludedUnknownTime,
		archiveBefore: deps.journal.snapshot.archiveBefore,
		platformCompleteness: "unknown",
		gaps: deps.journal.snapshot.coverageGaps.filter(
			(gap) =>
				(!params.conversationRef || !gap.conversationRef || gap.conversationRef === params.conversationRef) &&
				(until === null || Date.parse(gap.from) < until) &&
				(since === null || gap.to === null || Date.parse(gap.to) >= since),
		),
		unsearched: ["attachmentBytes", "json", "xml", "forward", "events", "platformHistorySnapshots"],
	};
	return listResult(deps, "search", { ...params, query, source: "local" }, items, {
		source: "local",
		searchableFields: ["text", "fileName"],
		coverage,
	});
}
