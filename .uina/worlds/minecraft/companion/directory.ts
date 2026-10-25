/** A view over the actual descriptors; no separately maintained capability catalogue. */
import type { BuiltCapabilities } from "../capabilities/index.js";
import type { CallableDescriptor, QueryDescriptor } from "../contracts/capabilities.js";
import { RpcError } from "../executor/ipc.js";
import { sha256Hex, canonicalJson } from "../runtime/rows.js";
import { plain } from "../contracts/values.js";

export function describeCapabilities(
	capabilities: BuiltCapabilities,
	params: { query?: string; cursor?: string; selector?: string; kind?: string; name?: string },
) {
	const descriptors: (CallableDescriptor | QueryDescriptor)[] = [
		...capabilities.queries,
		...capabilities.callables.map((c) => c.descriptor),
	];
	const exact = params.selector ?? (params.kind === "capability" ? params.name : undefined);
	const entry = (d: CallableDescriptor | QueryDescriptor) => ({
		kind: "capability",
		callable: d.access === "act",
		descriptor: d,
		availability: { state: "unknown", reasons: ["availability depends on the current connection and input"] },
		...(d.access === "act" ? { digest: sha256Hex(canonicalJson(plain(d))) } : {}),
		toolExamples: d.examples.map((e) => ({
			action: d.access === "act" ? "run" : "observe",
			params: { selector: d.ref, input: e.input },
		})),
	});
	if (exact) {
		const d = descriptors.find((d) => d.ref === exact);
		if (!d) throw new RpcError("NOT_FOUND", `capability ${exact} not found`);
		return entry(d);
	}
	if (params.kind) throw new RpcError("LIBRARY_UNAVAILABLE", "file Library is not delivered");
	if (params.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(params.cursor))
		throw new RpcError("CURSOR_INVALID", "invalid catalogue cursor");
	const q = (params.query ?? "").toLowerCase();
	const score = (d: CallableDescriptor | QueryDescriptor) => {
		const name = d.ref.toLowerCase();
		return name === q || name.split("@")[0] === q ? 0 : name.startsWith(q) ? 1 : 2;
	};
	const offset = Number(params.cursor ?? 0);
	const found = descriptors
		.filter((d) => [d.ref, d.summary, ...(d.tags ?? [])].some((v) => v.toLowerCase().includes(q)))
		.sort((a, b) => score(a) - score(b) || a.ref.localeCompare(b.ref));
	return {
		items: found.slice(offset, offset + 10).map((d) => ({
			kind: "capability",
			callable: d.access === "act",
			name: d.ref,
			ref: d.ref,
			summary: d.summary,
			tags: d.tags ?? [],
			access: d.access,
			availability: "unknown",
		})),
		...(found.length > offset + 10 ? { next: String(offset + 10) } : {}),
	};
}
