/** Real QQ acceptance: explicit --target is required; never retries writes or changes avatars. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { loadQqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { OneBotTransport } from "../.uina/worlds/qq/src/transport.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { MediaStaging } from "../.uina/worlds/qq/src/media.js";
import { handleQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";

const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
if (!args.includes("--target") || !target || !/^[1-9]\d+$/.test(target)) {
	throw new Error("Usage: pnpm exec tsx scripts/verify-qq-media.mts --target <authorized test QQ number>");
}
const loaded = loadQqWorldConfig();
if (!loaded.ok) throw new Error(loaded.error);
const config = loaded.config;
const dataDir = resolve("generated/qq-media-verification", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(dataDir, { recursive: true });
const journal = new FactsJournal({ dataDir, selfId: config.selfId });
journal.recover();
const control = new ControlStore({ dataDir, selfId: config.selfId });
control.load();
const ops = new OperationLog({ dataDir, selfId: config.selfId });
ops.recover();
ops.seedCounterFromExisting();
const staging = new MediaStaging({ stagingDir: join(dataDir, "staging"), ops });
const transport = new OneBotTransport({ connection: config.connection });
transport.onRaw((raw) => {
	if (typeof raw !== "string") return;
	try {
		const receipt = JSON.parse(raw) as { echo?: unknown; status?: unknown; retcode?: unknown; data?: unknown };
		if (typeof receipt.echo === "string") ops.settleFromEchoReceipt(receipt.echo, receipt, new Date().toISOString());
	} catch {
		/* Non-JSON transport frame. */
	}
});
const deps: QqAppDeps = {
	selfId: config.selfId,
	grants: config.grants,
	journal,
	control,
	ops,
	transport,
	attention: new AttentionModel({ control }),
	locks: new ConversationLocks(),
	media: { allowedRoots: config.media?.allowedRoots ?? [process.cwd(), dataDir], staging },
};

// Simple deterministic fixture, generated here without any user's image/audio content.
function chunk(type: string, body: Buffer): Buffer {
	const name = Buffer.from(type);
	const data = Buffer.concat([name, body]);
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([header, data, tail]);
}
const width = 256,
	height = 128;
const pixels = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++)
	for (let x = 0; x < width; x++) {
		const p = y * (width * 3 + 1) + 1 + x * 3;
		const bar = (x > 100 && x < 155) || (y > 48 && y < 80);
		pixels[p] = bar ? 240 : 30;
		pixels[p + 1] = bar ? 200 : 90;
		pixels[p + 2] = bar ? 30 : 170;
	}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const imagePath = join(dataDir, "uina-p7-image.png");
writeFileSync(
	imagePath,
	Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]),
);
const rate = 24000,
	samples = rate;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++)
	wav.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 3000), 44 + i * 2);
const audioPath = join(dataDir, "uina-p7-audio.wav");
writeFileSync(audioPath, wav);
const filePath = join(dataDir, "uina-p7-file.txt");
writeFileSync(
	filePath,
	"Uina QQ P7 media acceptance test.\nExpected: image, a one-second tone, and this file.\n",
	"utf8",
);

const evidence: Record<string, unknown> = {
	at: new Date().toISOString(),
	target,
	selfId: config.selfId,
	dataDir,
	results: [],
};
const results = evidence.results as Record<string, unknown>[];
try {
	const identity = await transport.start();
	if (String(identity.selfId) !== config.selfId) throw new Error("QQ login identity mismatch; no writes dispatched");
	const caps = await handleQqCall(deps, "observe", { account: config.selfId, scope: "capabilities" });
	evidence.capabilities = caps.details;
	const version = await transport.call("get_version_info");
	evidence.version = version.status === "ok" ? version.data : { status: version.status, reason: version.reason };
	const conversationRef = `p${target}`;
	if (args.includes("--mixed-only") && !args.includes("--probe-only")) {
		const result = await handleQqCall(deps, "speak", {
			account: config.selfId,
			conversationRef,
			content: [
				{ type: "file", name: "uina-p7-order-first.txt", resource: { kind: "file", path: filePath } },
				{ type: "text", text: "Uina P7 最终顺序验收：这条文字应位于 first.txt 与 last.txt 两个测试文件之间。" },
				{ type: "file", name: "uina-p7-order-last.txt", resource: { kind: "file", path: filePath } },
			],
		});
		const row = { type: "file-text-file", status: result.status, result: result.result, details: result.details };
		results.push(row);
		console.log(JSON.stringify(row));
		if (result.status !== "succeeded") process.exitCode = 1;
	}
	const outside = mkdtempSync(join(tmpdir(), "uina-qq-root-rejection-"));
	try {
		const outsidePath = join(outside, "fixture.txt");
		writeFileSync(outsidePath, "QQ media outside-root rejection fixture");
		const rejected = await handleQqCall(deps, "speak", {
			account: config.selfId,
			conversationRef,
			content: [{ type: "file", resource: { kind: "file", path: outsidePath } }],
		});
		evidence.outsideRoot = { status: rejected.status, details: rejected.details };
		if (rejected.status !== "failed") throw new Error("Outside-root fixture was not rejected");
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
	for (const [type, path] of [
		["text", ""],
		["image", imagePath],
		["audio", audioPath],
		["file", filePath],
	]) {
		if (args.includes("--probe-only") || args.includes("--mixed-only")) break;
		const content =
			type === "text"
				? [
						{
							type: "text",
							text: "Uina QQ P7 媒体验收：接下来发送测试图片（蓝底黄十字）、1秒测试音和文本文件。请确认收到及能否显示、播放、打开。",
						},
					]
				: [{ type, resource: { kind: "file", path } }];
		const result = await handleQqCall(deps, "speak", { account: config.selfId, conversationRef, content });
		const row = { type, status: result.status, result: result.result, details: result.details };
		results.push(row);
		console.log(JSON.stringify(row));
		if (result.status !== "succeeded") process.exitCode = 1;
		// Each write is attempted once. Other fixture types are independent of a format failure.
	}
	evidence.operations = ops.recent(20);
	evidence.peerPresentation = "unverified: requires recipient confirmation";
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	evidence.error = message.replaceAll(config.connection.accessToken, "[redacted]");
	console.log(JSON.stringify({ error: evidence.error }));
	process.exitCode = 1;
} finally {
	await transport.stop();
	writeFileSync(join(dataDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
	console.log(JSON.stringify({ evidence: join(dataDir, "evidence.json") }));
}
