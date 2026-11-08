/**
 * G16 断电边界：伴生执行进程在 runtime.db 写突发中途被 SIGKILL（非优雅关闭），
 * 同一数据根上的存储必须完整可用。
 *
 * 已有覆盖的边界：Host 投递 journal 的 SIGKILL（delivery-process）、优雅关闭重开
 * （mc-runtime-delivery）、IPC 断开与进程组退役（mc-executor-session/platform）。
 * 本测试补的是"runtime.db 自身在写事务中途被杀"：WAL+FULL 的崩溃一致性由真实
 * OS 进程实证，而不是假设——meta 身份不变、恢复只增不删、无半行损坏、托管重建
 * （autoRecover，批9B"执行侧重建"的生产路径）回到 ready 且 owner_lost 如实关闭、
 * 重开后受理与结算照常工作。
 *
 * 断电后的库取证全部走独立 Node 子进程（中性第三方，带 busy_timeout 与超时）：
 * 测试进程内打开崩溃恢复期的库会同步阻塞（批22 实测），取证进程隔离这一怪癖。
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";

const config = () => ({
	connection: {
		host: "127.0.0.1",
		port: 1, // 无游戏连接：受理后调用按合同诚实失败（DISCONNECTED），写入照常发生
		username: `T${randomUUID().slice(0, 8)}`,
		authMode: "offline",
		version: "1.21.11",
	},
	binding: null,
});

/** 伴生执行进程是测试进程的子进程（命令行含 companion/bootstrap），按父 PID 枚举定位。 */
function companionPid(): number {
	const out = spawnSync(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			`Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ` +
				`Where-Object { $_.CommandLine -like '*companion*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId`,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	const pid = Number(out.stdout.trim().split(/\s+/)[0]);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`companion process not found: ${out.stdout || out.stderr}`);
	return pid;
}

/** 断电取证：独立 Node 子进程只读检查库，stdout 取最后一个 JSON 行。 */
function forensic(script: string, dbPath: string, timeoutMs = 30000): Record<string, unknown> {
	const out = spawnSync(
		process.execPath,
		[
			"-e",
			`const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout = 5000");
const q = (sql) => db.prepare(sql).all();
console.log("RESULT=" + JSON.stringify((${script})(q, db)));`,
		],
		{ encoding: "utf8", timeout: timeoutMs, windowsHide: true },
	);
	if (out.status !== 0) throw new Error(`forensic query failed: ${out.stderr?.slice(0, 300)}`);
	const line = out.stdout
		.split("\n")
		.filter((l) => l.startsWith("RESULT="))
		.pop();
	if (line == null) throw new Error(`forensic query produced no result: ${out.stdout.slice(0, 200)}`);
	return JSON.parse(line.slice("RESULT=".length)) as Record<string, unknown>;
}

const COUNTS_SCRIPT = `(q) => ({
	storageId: q("SELECT value AS v FROM meta WHERE key='storage_id'")[0].v,
	schemaVersion: q("SELECT value AS v FROM meta WHERE key='schema_version'")[0].v,
	submissions: q("SELECT COUNT(*) AS n FROM submissions")[0].n,
	runs: q("SELECT COUNT(*) AS n FROM runs")[0].n,
	calls: q("SELECT COUNT(*) AS n FROM calls")[0].n,
	recordLog: q("SELECT COUNT(*) AS n FROM record_log")[0].n,
})`;

/** 所有 JSON 文本列都必须可解析（半行损坏在这里现形）。 */
const PARSE_SCRIPT = `(q) => {
	const tables = {
		submissions: ["request", "origin", "error"],
		runs: ["decision", "waiting", "value", "error", "unknown_effects", "progress"],
		calls: ["decision_request", "program", "input", "value", "closed_by_parent", "error", "progress", "effects", "evidence", "completion"],
		record_log: ["payload"],
	};
	let rows = 0;
	for (const [table, columns] of Object.entries(tables)) {
		for (const row of q("SELECT * FROM " + table)) {
			rows++;
			for (const column of columns) {
				const raw = row[column];
				if (typeof raw === "string" && raw.length > 0) JSON.parse(raw);
			}
		}
	}
	return { parsed: rows };
}`;

test("SIGKILL mid-write keeps runtime.db consistent and the executor recoverable", async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "uina-mc-kill-write-"));
	const dbPath = join(dataRoot, "runtime.db");
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			// autoRecover：伴生被杀后由父侧托管重建（本测试的恢复路径）。
			policy: { autoRecover: true, closeGraceMs: 3000 },
		});
		const owner = executor.status().side!.owner!;
		await executor.rpc("runtime.setOwnerGate", {
			requestId: randomUUID(),
			attachment: owner.attachment,
			gate: "disabled",
			closed: false,
			expectedRevision: owner.gateRevision,
		});

		// 顺序受理若干真实调用（无连接 → 调用诚实失败）：先保证库里有实质内容。
		let accepted = 0;
		for (let i = 0; i < 10; i++) {
			const reply = await executor.submit({
				requestId: `seed-${i}`,
				entry: { kind: "call", selector: "chat@1", input: { text: `seed ${i}` } },
				schedule: { kind: "enqueue" },
			});
			if (reply.kind === "accepted") accepted++;
		}
		expect(accepted).toBeGreaterThan(0);

		// 杀前快照（伴生活跃，进程内只读连接安全）。
		const pre = new DatabaseSync(dbPath);
		pre.exec("PRAGMA busy_timeout = 5000");
		const preCounts = {
			submissions: (pre.prepare("SELECT COUNT(*) AS n FROM submissions").get() as { n: number }).n,
			runs: (pre.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
			calls: (pre.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number }).n,
			record_log: (pre.prepare("SELECT COUNT(*) AS n FROM record_log").get() as { n: number }).n,
		};
		const preStorageId = (pre.prepare("SELECT value AS v FROM meta WHERE key='storage_id'").get() as { v: string }).v;
		pre.close();

		// 杀点选择：最后一次受理的回执刚到（IPC 空闲），而伴生仍在结算该 run 的
		// 调用失败/记录/效果写入——SIGKILL 落在 SQLite 写活动窗口内，且不撞 IPC 半包
		// （批22 实测：杀在 send 中途会让 vitest 报 EPIPE 逃逸，与存储完整性无关）。
		const killSubmit = executor
			.submit({
				requestId: "kill-marker",
				entry: { kind: "call", selector: "chat@1", input: { text: "kill marker" } },
				schedule: { kind: "enqueue" },
			})
			.then(
				(reply) => reply,
				() => null,
			);
		await killSubmit;
		const killedPid = companionPid();
		process.kill(killedPid, "SIGKILL");

		// 伴生死后对端关闭应让后续提交被诚实拒绝（不受理、不悬挂）。
		// 注意 submit 在对端关闭后会同步 throw（peer closed 检查），.catch 接不住，必须 try/catch。
		const stormReplies: unknown[] = [];
		for (let i = 0; i < 5; i++) {
			try {
				stormReplies.push(
					await executor.submit({
						requestId: `storm-${i}`,
						entry: { kind: "call", selector: "chat@1", input: { text: `storm ${i}` } },
						schedule: { kind: "enqueue" },
					}),
				);
			} catch (error) {
				stormReplies.push({ kind: "unknown", reason: String(error) });
			}
		}
		expect(stormReplies.length).toBe(5);

		// 托管重建：父进程存活，伴生被杀后由 autoRecover 重新拉起；unclean 重启关 owner_lost。
		const rebuildDeadline = Date.now() + 30000;
		let rebuilt = false;
		while (Date.now() < rebuildDeadline) {
			const status = executor.status();
			if (status.phase === "ready" && status.side != null) {
				rebuilt = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		expect(rebuilt, "managed rebuild did not return to ready after the kill").toBe(true);

		// 断电取证（独立进程）：存储身份不变、恢复只增不删、无半行损坏。
		const post = forensic(COUNTS_SCRIPT, dbPath) as {
			storageId: string;
			schemaVersion: string;
			submissions: number;
			runs: number;
			calls: number;
			recordLog: number;
		};
		expect(post.storageId).toBe(preStorageId);
		expect(post.schemaVersion).toBe("6");
		expect(post.submissions).toBeGreaterThanOrEqual(preCounts.submissions);
		expect(post.runs).toBeGreaterThanOrEqual(preCounts.runs);
		expect(post.calls).toBeGreaterThanOrEqual(preCounts.calls);
		expect(post.recordLog).toBeGreaterThanOrEqual(preCounts.record_log);
		const parsed = forensic(PARSE_SCRIPT, dbPath) as { parsed: number };
		expect(parsed.parsed).toBeGreaterThan(0);

		// 非优雅重启后 owner_lost 由机械对账自动解除（旧执行树已被证明退役），
		// 不需要模型再走两轮 runs recover；受理与结算照常（库真正可用，不只是能读）。
		expect(executor.status().recovery.clearedGates).toContain("owner_lost");
		expect(executor.status().side!.owner!.gates).not.toContain("owner_lost");
		const gateDeadline = Date.now() + 10000;
		while (!executor.status().actionsAllowed && Date.now() < gateDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const probe = await executor.submit({
			requestId: "post-kill-probe",
			entry: { kind: "call", selector: "chat@1", input: { text: "probe" } },
			schedule: { kind: "enqueue" },
		});
		const postStatus = executor.status();
		expect(
			probe.kind,
			`probe refused: ${JSON.stringify(probe)}; gates=${JSON.stringify(postStatus.side?.owner?.gates)}`,
		).toBe("accepted");

		// 探针 run 必须落终态且错误诚实（无连接 → DISCONNECTED），不留 running 悬账。
		// 轮询在取证子进程内部完成（带 15s 上限），避免测试进程内读库。
		const settled = forensic(
			`(q, db) => {
					const deadline = Date.now() + 14000;
					while (Date.now() < deadline) {
						const row = q("SELECT phase, outcome, error FROM runs WHERE request_id='post-kill-probe'")[0];
						if (row && row.phase === "finished") return row;
						db.exec("SELECT 1");
						const until = Date.now() + 100;
						while (Date.now() < until);
					}
					return { phase: "unsettled" };
				}`,
			dbPath,
		) as { phase: string; outcome: string | null; error: string | null };
		expect(settled.phase, `probe run did not settle: ${JSON.stringify(settled)}`).toBe("finished");
		expect(settled.outcome).toBe("failed");
		expect(JSON.parse(settled.error ?? "{}").code).toBe("DISCONNECTED");
	} finally {
		await executor?.close().catch(() => {});
		// Windows 上句柄释放有迟滞：EBUSY 重试而不是让清理污染测试结果。
		await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120000);
