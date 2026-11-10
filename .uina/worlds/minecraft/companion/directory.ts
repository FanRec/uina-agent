/** Discovery projects descriptors and live Library metadata; it owns no file index. */
import type { AddonStatus, DirectorySnapshot } from "../contracts/addons.js";
import type { CallableDescriptor, QueryDescriptor, SearchSummary } from "../contracts/capabilities.js";
import type { LibraryKind, LibraryPort } from "../contracts/library.js";
import { RpcError } from "../executor/ipc.js";
import { COLLECT_DEFAULT_COUNT } from "../program/collect.js";
import { findGuide, guideSummaries, readGuide } from "./guides/index.js";

export interface DescribeParams {
	query?: string;
	cursor?: string;
	selector?: string;
	includeSource?: boolean;
	kind?: "capability" | "guide" | "addon" | LibraryKind;
	name?: string;
}

const normalize = (value: string) =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

// Search vocabulary is presentation data. It must not change a frozen capability contract.
const aliases = new Map([
	["collect@1", ["采集", "原木", "木头", "砍树", "收集资源", "gather resources", "wood", "log", "chop tree"]],
	["explore@1", ["探索", "找个高处看看", "看看附近", "探路", "scout", "look around"]],
	["build@1", ["建造", "盖房子", "建避难所", "construction", "shelter"]],
	["build.plan@1", ["施工差异", "检查建造", "建造计划", "construction plan"]],
	["build.resume@1", ["恢复施工", "继续施工", "续建", "resume construction", "resume"]],
]);

function searchResult(item: SearchSummary, input?: QueryDescriptor["input"]) {
	const { name, kind, summary, reason } = item;
	const base = { name, kind, summary, ...(reason ? { reason } : {}) };
	if (kind === "capability") {
		const use = item.access === "read" ? "observe" : "run";
		const required = Array.isArray(input?.required) ? input.required.filter((key) => typeof key === "string") : [];
		// Only a plain object schema with no required fields proves that {} is valid.
		const emptyAllowed =
			input?.type === "object" &&
			!required.length &&
			Object.keys(input).every((key) =>
				["type", "properties", "required", "additionalProperties", "description", "title"].includes(key),
			);
		return {
			...base,
			use,
			...(required.length ? { required } : {}),
			...(name === "collect@1" ? { defaults: { count: COLLECT_DEFAULT_COUNT } } : {}),
			nextCall: { action: emptyAllowed ? use : "describe", params: { selector: name } },
		};
	}
	if (kind === "program") return { ...base, use: "run", nextCall: { action: "describe", params: { selector: name } } };
	const nextCall =
		kind === "guide" || kind === "addon"
			? { action: "describe", params: { kind, name } }
			: { action: "library", params: { op: "get", kind, name } };
	return { ...base, nextCall };
}
/**
 * 目录投影：descriptor 来自**真实装配**（活动 Companion 快照或内置模块），
 * 这里不再持有 Catalog，也不再为第三方能力另编一份静态 Schema。
 * `addons` 只描述包状态：包内能力仍按各自 ref 出现在 descriptors 里。
 */
export async function describeDirectory(
	descriptors: readonly (QueryDescriptor | CallableDescriptor)[],
	library: LibraryPort,
	params: DescribeParams,
	addons: readonly AddonStatus[] = [],
	publication?: Pick<DirectorySnapshot, "publishedPrograms" | "programSource">,
) {
	const capability = (d: CallableDescriptor | QueryDescriptor) => ({
		kind: "capability",
		callable: d.access === "act",
		descriptor: d,
		availability: { state: "unknown", reasons: ["availability depends on current connection and input"] },
	});
	const exact = params.selector ?? params.name;
	if (exact !== undefined) {
		const kind = params.kind ?? (exact.includes("@") ? "capability" : "program");
		if (params.includeSource && kind !== "capability")
			throw new RpcError("INVALID_INPUT", "use library.get to read a personal Program");
		if (kind === "capability") {
			const d = descriptors.find((d) => d.ref === exact);
			if (!d) throw new RpcError("NOT_FOUND", `capability ${exact} not found`);
			const sourceAvailable = publication?.publishedPrograms.some((ref) => ref === exact) === true;
			return {
				...capability(d),
				...(sourceAvailable || params.includeSource ? { sourceAvailable } : {}),
				...(sourceAvailable && !params.includeSource
					? { sourceCall: { action: "describe", params: { selector: exact, includeSource: true } } }
					: {}),
				...(params.includeSource && sourceAvailable ? { programSource: publication?.programSource } : {}),
			};
		}
		if (kind === "addon") {
			const status = addons.find((addon) => addon.id === exact);
			if (!status) throw new RpcError("NOT_FOUND", `addon ${exact} is not part of this session directory`);
			const contributed = status.contributed;
			return {
				kind: "addon",
				callable: false,
				name: status.id,
				summary: `${status.id}@${status.version} (${status.state})`,
				tags: [status.state],
				status,
				capabilities: [...contributed.refs],
				note:
					status.serverRequirement == null
						? "no server-side requirement declared"
						: `${status.serverRequirement.kind} ${status.serverRequirement.id} is declared as required for ${status.serverRequirement.requiredFor}; declaration is not proof the server has it`,
				...(contributed.actions + contributed.queries === 0
					? { hint: "this addon contributes no callable capabilities" }
					: {}),
			};
		}
		if (kind === "guide") {
			const guide = findGuide(exact);
			if (!guide) throw new RpcError("NOT_FOUND", `guide ${exact} not found; describe {} lists families`);
			// 官方只读资料：正文直接随 describe 返回，不落到 Library、不要求连接。
			const content = await readGuide(exact);
			return {
				kind: "guide",
				callable: false,
				name: guide.name,
				summary: guide.summary,
				tags: [...guide.tags],
				content,
			};
		}
		const d = await library.get(kind, exact);
		if (!d) throw new RpcError("NOT_FOUND", `${kind} ${exact} not found`);
		if (d.kind === "program") {
			const { source: _source, kind: _kind, ...program } = d;
			return {
				kind,
				callable: true,
				program,
				completion: { scope: "execution" },
				availability: {
					state: d.headerError ? "unavailable" : "unknown",
					reasons: d.headerError ? [d.headerError] : [],
				},
				contracts: {
					input: d.input === undefined ? "undeclared" : "declared",
					output: d.output === undefined ? "undeclared" : "declared",
					examples: d.examples === undefined ? "undeclared" : "declared",
				},
				callShape: { action: "run", params: { selector: d.name, input: "<input matching the declared contract>" } },
				toolExamples: (d.examples ?? []).map((e) => ({ action: "run", params: { selector: d.name, input: e.input } })),
				programExamples: (d.examples ?? []).map(
					(e) => `await mc.call(${JSON.stringify(d.name)}, ${JSON.stringify(e.input)});`,
				),
			};
		}
		const { kind: _kind, ...data } = d;
		const metadata =
			d.kind === "experience" ? { header: d.header } : { about: d.about, formatHint: d.formatHint, target: d.target };
		return {
			kind,
			callable: false,
			name: d.name,
			summary: d.summary,
			tags: d.tags,
			path: d.path,
			...(d.headerError ? { headerError: d.headerError } : {}),
			...(d.aboutError ? { aboutError: d.aboutError } : {}),
			metadata,
			digest: data.digest,
			readCall: { action: "library", params: { op: "get", kind, name: d.name } },
		};
	}
	if (params.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(params.cursor))
		throw new RpcError("CURSOR_INVALID", "invalid catalogue cursor");
	const entries = await library.list({ limit: Number.MAX_SAFE_INTEGER });
	if (params.query === undefined && params.cursor === undefined)
		return {
			families: [
				{ kind: "capability", count: descriptors.length },
				{ kind: "guide", count: guideSummaries().length },
				{ kind: "addon", count: addons.length },
				...(["program", "blueprint", "experience"] as const).map((kind) => ({
					kind,
					count: entries.filter((e) => e.kind === kind).length,
				})),
			],
			// 一次给全名：模型的 selector 是确切 ref，没有名字就只能盲搜。
			reads: descriptors.filter((d) => d.access === "read").map((d) => d.ref),
			acts: descriptors.filter((d) => d.access === "act").map((d) => d.ref),
		};
	const candidates: SearchSummary[] = [
		...descriptors.map((d) => ({
			kind: "capability" as const,
			callable: d.access === "act",
			name: d.ref,
			ref: d.ref,
			summary: d.summary,
			tags: d.tags ?? [],
			access: d.access,
			availability: "unknown" as const,
		})),
		...guideSummaries().map((guide) => ({
			kind: "guide" as const,
			callable: false,
			name: guide.name,
			summary: guide.summary,
			tags: [...guide.tags],
			availability: "unknown" as const,
		})),
		...addons.map((addon) => ({
			kind: "addon" as const,
			callable: false,
			name: addon.id,
			summary: `${addon.id}@${addon.version} (${addon.state})`,
			tags: [addon.state],
			availability: "unknown" as const,
		})),
		...entries.map((e) => ({
			kind: e.kind,
			callable: e.kind === "program",
			name: e.name,
			summary: e.summary,
			tags: e.tags,
			path: e.path,
			availability: e.headerError ? ("unavailable" as const) : ("unknown" as const),
			...((e.headerError ?? (e.kind === "program" ? undefined : e.aboutError))
				? { reason: e.headerError ?? (e.kind === "program" ? undefined : e.aboutError) }
				: {}),
		})),
	];
	const q = normalize(params.query ?? "");
	const words = [...new Set(q.split(" ").filter(Boolean))];
	const found = candidates
		.flatMap((item) => {
			const name = normalize(item.name);
			const known = aliases.get(item.ref ?? "") ?? [];
			const matches = known.filter((alias) =>
				/\p{Script=Han}/u.test(alias) ? q.includes(alias) : ` ${q} `.includes(` ${alias} `),
			);
			const fields = [name, normalize(item.summary ?? ""), ...item.tags.map(normalize)];
			const terms = words.filter((word) => fields.some((field) => field.split(" ").includes(word))).length;
			const exact = name === q || (item.kind === "capability" && normalize(item.name.split("@")[0]!) === q);
			const prefix = q !== "" && name.startsWith(q);
			if (q && !exact && !matches.length && !terms && !prefix) return [];
			return [{ item, rank: exact ? 0 : matches.length ? 1 : 2, matches: matches.length, terms, prefix }];
		})
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				b.matches - a.matches ||
				b.terms - a.terms ||
				Number(b.prefix) - Number(a.prefix) ||
				a.item.kind.localeCompare(b.item.kind) ||
				a.item.name.localeCompare(b.item.name),
		);
	const offset = Number(params.cursor ?? 0);
	if (!Number.isSafeInteger(offset)) throw new RpcError("CURSOR_INVALID", "invalid catalogue cursor");
	const inputs = new Map<string, QueryDescriptor["input"]>(descriptors.map((d) => [d.ref, d.input]));
	const page = found.slice(offset, offset + 10).map(({ item }) => searchResult(item, inputs.get(item.name)));
	return {
		items: page,
		...(found.length > offset + 10 ? { next: String(offset + 10) } : {}),
		// 空结果不说"没找到"，直接给下一步：模型不会反复换关键词试探。
		...(page.length === 0 ? { hint: "no match; describe {} lists all capability refs" } : {}),
	};
}
