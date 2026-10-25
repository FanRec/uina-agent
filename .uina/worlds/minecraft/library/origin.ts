/** Composition adapter: committed Runtime identity plus Program's verified snapshot. */
import { readFile } from "node:fs/promises";
import type { ProgramOrigin } from "../contracts/library.js";
import type { RecordReply, RunSummary, CallRecord } from "../contracts/runtime.js";
import type { ProgramPort } from "../contracts/program.js";
import { libraryError, digest } from "./files.js";

export async function readCallSource(
	origin: ProgramOrigin,
	deps: {
		readRun(run: string): Promise<RunSummary>;
		readRecord(ref: string): Promise<RecordReply>;
		readSnapshot: ProgramPort["readSnapshot"];
	},
): Promise<{ source: string; digest: string } | null> {
	// The Runtime opened by this composition root already binds storageId/worldOwner.
	const [run, reply] = await Promise.all([deps.readRun(origin.run), deps.readRecord(origin.call)]);
	let record: Extract<RecordReply, { kind: "inline" }>["record"];
	if (reply.kind === "inline") record = reply.record;
	else {
		// This path comes only from the trusted Runtime reply, never the save request.
		const bytes = await readFile(reply.file.path);
		if (bytes.length !== reply.file.bytes || digest(bytes) !== reply.file.sha256)
			libraryError("IO_ERROR", "exported Call record changed");
		record = JSON.parse(bytes.toString("utf8")) as typeof record;
	}
	if (record.kind !== "call") libraryError("NOT_FOUND", "source is not a program Call");
	const call = record.value as unknown as CallRecord;
	if (
		run.run !== origin.run ||
		call.run !== origin.run ||
		call.segment !== origin.segment ||
		call.call !== origin.call ||
		call.implementation !== "program" ||
		!call.program ||
		call.digest !== call.program.digest
	)
		libraryError("NOT_FOUND", "source Call identity does not match run/segment/program");
	const snapshot = await deps.readSnapshot({ run: origin.run, digest: call.program.digest });
	return snapshot ? { source: snapshot.source, digest: call.program.digest } : null;
}
