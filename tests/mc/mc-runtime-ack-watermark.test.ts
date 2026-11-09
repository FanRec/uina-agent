/**
 * §5.3 派发前屏障的活性证据：DB worker 的 ACK 水线必须覆盖本批**全部**已确认
 * 提交的材料。record_log 幂等跳过不代表该 seq 未提交；若 ACK 因此低报或干脆不
 * 发，RecordQueue.flushThrough(ticket) 的 waiter 永不 resolve，写前 intent 挂死。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test } from "vitest";
import type {
	ApplyItem,
	WorkerRequest,
	WorkerResponse,
} from "../../.uina/worlds/minecraft/runtime/runtime-db-worker.js";

const workers: Worker[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.terminate();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function item(sequence: number): ApplyItem {
	return {
		ticket: { instance: "rw:ack:1", sequence },
		mutation: { kind: "owner_state", gates: "[]", revision: sequence },
	};
}

function boot() {
	const worker = new Worker(new URL("../../.uina/worlds/minecraft/runtime/worker-entry.ts", import.meta.url));
	workers.push(worker);
	let deliver: (message: WorkerResponse) => void = () => {};
	worker.on("message", (message: WorkerResponse) => deliver(message));
	const next = () =>
		new Promise<WorkerResponse>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("worker produced no durable ACK within 2s")), 2000);
			deliver = (message) => {
				clearTimeout(timer);
				resolve(message);
			};
		});
	return { worker, next };
}

test("幂等重放的批次仍回报完整上界，不低报也不静默丢弃 ACK", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-ack-watermark-"));
	roots.push(root);
	const dbPath = join(root, "runtime.db");
	const { worker, next } = boot();

	const opened = next();
	worker.postMessage({ type: "open", dbPath, storageId: "ack", worldOwner: "owner" } satisfies WorkerRequest);
	expect((await opened).type).toBe("opened");

	const batch = [item(1), item(2), item(3)];
	const first = next();
	worker.postMessage({ type: "apply", items: batch } satisfies WorkerRequest);
	expect(await first).toMatchObject({ type: "durable", instance: "rw:ack:1", through: 3 });

	// 同载荷重放：三条都命中 record_log 幂等跳过，但它们的确已提交。
	// 修复前 lastSeq 只在 INSERT 分支更新 → ack=null → 不发 durable → 屏障挂死。
	const replay = next();
	worker.postMessage({ type: "apply", items: batch } satisfies WorkerRequest);
	expect(await replay).toMatchObject({ type: "durable", instance: "rw:ack:1", through: 3 });
});

test("批次尾部是幂等项时，ACK 仍推进到新提交材料的上界", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-ack-watermark-"));
	roots.push(root);
	const dbPath = join(root, "runtime.db");
	const { worker, next } = boot();

	const opened = next();
	worker.postMessage({ type: "open", dbPath, storageId: "ack", worldOwner: "owner" } satisfies WorkerRequest);
	expect((await opened).type).toBe("opened");

	const first = next();
	worker.postMessage({ type: "apply", items: [item(1), item(2)] } satisfies WorkerRequest);
	expect(await first).toMatchObject({ type: "durable", instance: "rw:ack:1", through: 2 });

	// seq 4 是新材料，seq 2 是已提交材料：上界必须是 4，不能停在最后一次 INSERT 之外。
	const mixed = next();
	worker.postMessage({ type: "apply", items: [item(4), item(2)] } satisfies WorkerRequest);
	expect(await mixed).toMatchObject({ type: "durable", instance: "rw:ack:1", through: 4 });
});
