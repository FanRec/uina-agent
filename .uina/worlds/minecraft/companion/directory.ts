/** Discovery projects descriptors and live Library metadata; it owns no file index. */
import type { BuiltCapabilities } from "../capabilities/index.js";
import type { CallableDescriptor, QueryDescriptor, SearchSummary } from "../contracts/capabilities.js";
import type { LibraryPort, LibraryKind } from "../contracts/library.js";
import { RpcError } from "../executor/ipc.js";
import { sha256Hex, canonicalJson } from "../runtime/rows.js";
import { plain } from "../contracts/values.js";

export interface DescribeParams {
	query?: string;
	cursor?: string;
	selector?: string;
	kind?: "capability" | LibraryKind;
	name?: string;
}
export async function describeDirectory(capabilities: BuiltCapabilities, library: LibraryPort, params: DescribeParams) {
	const descriptors: (CallableDescriptor | QueryDescriptor)[] = [
		...capabilities.queries,
		...capabilities.callables.map((c) => c.descriptor),
	];
	const native = (d: CallableDescriptor | QueryDescriptor) => ({
		kind: "capability",
		callable: d.access === "act",
		descriptor: d,
		availability: { state: "unknown", reasons: ["availability depends on current connection and input"] },
		...(d.access === "act" ? { digest: sha256Hex(canonicalJson(plain(d))) } : {}),
		toolExamples: d.examples.map((e) => ({
			action: d.access === "act" ? "run" : "observe",
			params: { selector: d.ref, input: e.input },
		})),
		programExamples: d.examples.map(
			(e) => `await mc.${d.access === "act" ? "call" : "read"}(${JSON.stringify(d.ref)}, ${JSON.stringify(e.input)});`,
		),
	});
	const exact = params.selector ?? params.name;
	if (exact !== undefined) {
		const kind = params.kind ?? (exact.includes("@") ? "capability" : "program");
		if (kind === "capability") {
			const d = descriptors.find((d) => d.ref === exact);
			if (!d) throw new RpcError("NOT_FOUND", `capability ${exact} not found`);
			return native(d);
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
				...(["program", "blueprint", "experience"] as const).map((kind) => ({
					kind,
					count: entries.filter((e) => e.kind === kind).length,
				})),
			],
			nextCall: { action: "describe", params: { query: "" } },
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
	const q = (params.query ?? "").toLowerCase();
	const score = (d: SearchSummary) =>
		d.name.toLowerCase() === q || (d.kind === "capability" && d.name.split("@")[0] === q)
			? 0
			: d.name.toLowerCase().startsWith(q)
				? 1
				: 2;
	const found = candidates
		.filter((d) => [d.name, d.summary ?? "", ...d.tags].some((v) => v.toLowerCase().includes(q)))
		.sort((a, b) => score(a) - score(b) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
	const offset = Number(params.cursor ?? 0);
	if (!Number.isSafeInteger(offset)) throw new RpcError("CURSOR_INVALID", "invalid catalogue cursor");
	return {
		items: found.slice(offset, offset + 10),
		...(found.length > offset + 10 ? { next: String(offset + 10) } : {}),
	};
}
