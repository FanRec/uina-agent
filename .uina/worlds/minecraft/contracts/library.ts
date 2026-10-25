/** Library owns working-file contracts. Program only consumes parsed material. */
import type { JsonSchema, JsonValue, Ref } from "./values.js";

export interface ProgramExample {
	input: JsonValue;
	output?: JsonValue;
}
export interface ProgramHeader {
	summary?: string;
	tags?: string[];
	input?: JsonSchema;
	output?: JsonSchema;
	examples?: ProgramExample[];
	saved?: { run: Ref; segment: Ref; call: Ref; digest: string; at: string };
}
export interface ProgramSummary {
	name: string;
	summary: string | null;
	tags: string[];
	digest: string;
	path: string;
	updatedAt: string;
	headerError?: string;
}
export interface ProgramDetail extends ProgramSummary {
	source: string;
	input?: JsonSchema;
	output?: JsonSchema;
	examples?: ProgramExample[];
	savedFrom?: ProgramHeader["saved"];
}
export type ProgramDescription = Omit<ProgramDetail, "source">;
export interface ProgramMetadataPatch {
	summary?: string;
	tags?: string[] | null;
	input?: JsonSchema | null;
	output?: JsonSchema | null;
	examples?: ProgramExample[] | null;
}
export interface ProgramOrigin {
	run: Ref;
	segment: Ref;
	call: Ref;
}
export type LibraryKind = "program" | "blueprint" | "experience";
export interface LibraryListQuery {
	kind?: LibraryKind;
	text?: string;
	tag?: string;
	limit?: number;
}
export interface TextMetadata {
	summary?: string;
	tags?: string[];
	applies?: string[];
}
export interface FileEntrySummary {
	name: string;
	summary: string | null;
	tags: string[];
	path: string;
	updatedAt: string;
	size?: number;
	digest?: string;
	aboutError?: string;
	headerError?: string;
}
export type LibrarySummary =
	| ({ kind: "program" } & ProgramSummary)
	| ({ kind: "blueprint" | "experience" } & FileEntrySummary);
export type LibraryDetail =
	| ({ kind: "program" } & ProgramDetail)
	| ({ kind: "blueprint" } & FileEntrySummary & {
				about: TextMetadata | null;
				files: string[];
				digest: string;
				size: number;
				formatHint: string;
				target?: { schema: string; digest: string; validation: "unavailable" };
			})
	| ({ kind: "experience" } & FileEntrySummary & { header: TextMetadata | null; text: string });
export type LibrarySaveRequest =
	| ({
			kind?: "program";
			name: string;
			summary: string;
			tags?: string[];
			input?: JsonSchema;
			output?: JsonSchema;
			examples?: ProgramExample[];
	  } & ({ source: string; from?: never } | { from: ProgramOrigin; source?: never }))
	| { kind: "blueprint"; name: string; summary: string; tags?: string[] }
	| { kind: "experience"; name: string; text: string };
export type LibraryUpdateRequest =
	| ({ kind?: "program"; name: string; expectedDigest?: string } & (
			| { source: string; metadata?: never }
			| { metadata: ProgramMetadataPatch; source?: never }
	  ))
	| { kind: "blueprint"; name: string; metadata: { summary?: string; tags?: string[] | null } }
	| ({ kind: "experience"; name: string; expectedDigest?: string } & (
			| { text: string; metadata?: never }
			| { metadata: { summary?: string | null; tags?: string[] | null; applies?: string[] | null }; text?: never }
	  ));
export type LibraryRequest =
	| ({ op: "list" } & LibraryListQuery)
	| { op: "get" | "delete"; kind?: LibraryKind; name: string }
	| ({ op: "save" } & LibrarySaveRequest)
	| ({ op: "update" } & LibraryUpdateRequest);
export interface LibraryPort {
	list(query?: LibraryListQuery): Promise<LibrarySummary[]>;
	get(kind: LibraryKind, name: string): Promise<LibraryDetail | null>;
	save(request: LibrarySaveRequest): Promise<LibrarySummary>;
	update(request: LibraryUpdateRequest): Promise<LibrarySummary>;
	delete(kind: LibraryKind, name: string): Promise<void>;
}
