import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	acquireOwnership,
	selfProcessIdentity,
	type ManagedProcess,
	type WindowsOwnership,
} from "../../.uina/worlds/minecraft/executor/platform/index.js";

const fixture = new URL("./fixtures/executor-platform.mjs", import.meta.url);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-job-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	return root;
}
function own(root: string, account = randomUUID()) {
	const owner = acquireOwnership(root, account);
	cleanups.push(() => owner.close());
	return owner;
}
function start(mode = "tree", args: string[] = []) {
	const child = fork(fixture, [mode, ...args], {
		// Native Node type stripping avoids tsx/esbuild's own subprocess Job,
		// which could independently reap the tree and invalidate this OS evidence.
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	cleanups.push(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
	});
	return child;
}
async function message(
	child: ChildProcess,
): Promise<{ identity: { pid: number; createdAt: string }; tree: { pid: number; createdAt: string }[] }> {
	return (await once(child, "message"))[0];
}
async function retire(owner: WindowsOwnership, process: ManagedProcess) {
	owner.terminate();
	expect(await owner.waitRetired(process, 5000)).toBe(true);
	process.close();
}

describe.skipIf(process.platform !== "win32")("Windows Executor ownership (real OS)", () => {
	const helperPath = fileURLToPath(new URL("./fixtures/executor-platform-jobs.node", import.meta.url));
	let helper: { anchorAccount(digest: string, pid: number): void };
	beforeAll(() => {
		const cache =
			process.env.MC_NODE_HEADERS ?? join(process.env.LOCALAPPDATA!, "node-gyp", "Cache", process.versions.node);
		const compiled = spawnSync(
			process.env.MC_NATIVE_CXX ?? "g++",
			[
				"-std=c++17",
				"-O2",
				"-shared",
				"-static",
				"-I",
				join(cache, "include", "node"),
				fileURLToPath(new URL("./fixtures/executor-platform-jobs.cc", import.meta.url)),
				join(cache, "x64", "node.lib"),
				"-o",
				helperPath,
			],
			{ encoding: "utf8", windowsHide: true },
		);
		if (compiled.error || compiled.status !== 0) throw compiled.error ?? new Error(compiled.stderr);
		helper = createRequire(import.meta.url)(helperPath);
	});
	it("reads exact process creation identity and handles without rounding", async () => {
		const owner = own(await directory());
		const self = owner.openProcess(process.pid);
		expect(self.identity).toEqual(selfProcessIdentity());
		expect(self.identity.createdAt).toMatch(/^\d{17,}$/);
		self.close();
	});
	it("rejects directory aliases and competing accounts without affecting the owner", async () => {
		const root = await directory();
		const data = join(root, "Data");
		const alias = join(root, "alias");
		await mkdir(data);
		await symlink(data, alias, "junction");
		const account = randomUUID();
		const owner = own(data, account);
		expect(() => acquireOwnership(data.toUpperCase(), randomUUID())).toThrow(/DATA_DIR_BUSY/);
		expect(() => acquireOwnership(alias, randomUUID())).toThrow(/DATA_DIR_BUSY/);
		const other = join(root, "other");
		await mkdir(other);
		expect(() => acquireOwnership(other, account)).toThrow(/ACCOUNT_BUSY/);
		const independent = own(other);
		expect(independent.activeProcesses()).toEqual({ directory: 0, account: 0 });
		const child = start();
		const hello = await message(child);
		const managed = owner.openProcess(child.pid!);
		expect(managed.identity).toEqual(hello.identity);
		owner.assign(managed);
		expect(owner.activeProcesses()).toEqual({ directory: 1, account: 1 });
		await retire(owner, managed);
	});
	it("waits for the exact process and both Job counts without blocking the event loop", async () => {
		const owner = own(await directory());
		const child = start();
		await message(child);
		const managed = owner.openProcess(child.pid!);
		owner.assign(managed);
		const tree = message(child);
		child.send("tree");
		await tree;
		expect(owner.activeProcesses()).toEqual({ directory: 2, account: 2 });
		const exited = once(child, "exit");
		child.send("exit");
		await exited;
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		expect(await owner.waitRetired(managed, 120)).toBe(false);
		clearInterval(timer);
		expect(ticks).toBeGreaterThan(2);
		expect(() => owner.close()).toThrow(/NOT_RETIRED/);
		await retire(owner, managed);
		expect(owner.activeProcesses()).toEqual({ directory: 0, account: 0 });
	});
	it("keeps names exclusive until retirement and explicit close, then allows reuse", async () => {
		const root = await directory();
		const account = randomUUID();
		const owner = own(root, account);
		const child = start();
		await message(child);
		const managed = owner.openProcess(child.pid!);
		owner.assign(managed);
		await retire(owner, managed);
		expect(() => acquireOwnership(root, account)).toThrow(/DATA_DIR_BUSY/);
		owner.close();
		const replacement = own(root, account);
		expect(replacement.activeProcesses()).toEqual({ directory: 0, account: 0 });
	});
	it("kills child and grandchild after owner is force killed and releases both names", async () => {
		const root = await directory();
		const account = randomUUID();
		const owner = start("owner", [root, account]);
		const ready = await message(owner);
		const observer = own(await directory());
		const handles = ready.tree.map((identity) => {
			const handle = observer.openProcess(identity.pid);
			expect(handle.identity).toEqual(identity);
			cleanups.push(() => handle.close());
			return handle;
		});
		expect(() => acquireOwnership(root, account)).toThrow(/DATA_DIR_BUSY/);
		const exited = once(owner, "exit");
		owner.kill("SIGKILL");
		await exited;
		for (const handle of handles) expect(await observer.waitRetired(handle, 5000)).toBe(true);
		const replacement = own(root, account);
		expect(replacement.activeProcesses()).toEqual({ directory: 0, account: 0 });
	});
	it("rejects foreign or closed process handles and can terminate a pre-assignment bootstrap", async () => {
		const owner = own(await directory());
		const other = own(await directory());
		const child = start();
		await message(child);
		const managed = owner.openProcess(child.pid!);
		expect(() => other.assign(managed)).toThrow(/PROCESS_OWNERSHIP/);
		managed.terminate();
		expect(await owner.waitRetired(managed, 5000)).toBe(true);
		managed.close();
		expect(() => owner.assign(managed)).toThrow(/PROCESS_CLOSED/);
	});
	it("supports a compatible inherited external Job and rejects an incompatible sibling hierarchy", async () => {
		const owner = own(await directory());
		const holder = start("external", [helperPath, "compatible"]);
		const hello = await message(holder);
		const managed = owner.openProcess(hello.identity.pid);
		owner.assign(managed);
		expect(owner.activeProcesses()).toEqual({ directory: 1, account: 1 });
		const incompatibleHolder = start("external", [helperPath, "compatible"]);
		const incompatibleHello = await message(incompatibleHolder);
		const incompatible = owner.openProcess(incompatibleHello.identity.pid);
		expect(() => owner.assign(incompatible)).toThrow(/DIRECTORY_ASSIGN_FAILED/);
		expect(owner.activeProcesses()).toEqual({ directory: 1, account: 1 });
		incompatible.terminate();
		await retire(owner, managed);
		expect(await owner.waitRetired(incompatible, 5000)).toBe(true);
		incompatible.close();
	});
	it("keeps directory ownership after second assignment fails until the exact bootstrap exits", async () => {
		const account = randomUUID();
		const root = await directory();
		const owner = own(root, account);
		const anchorHolder = start("external", [helperPath, "compatible"]);
		const anchorHello = await message(anchorHolder);
		helper.anchorAccount(createHash("sha256").update(account).digest("hex"), anchorHello.identity.pid);
		const child = start();
		await message(child);
		const managed = owner.openProcess(child.pid!);
		expect(() => owner.assign(managed)).toThrow(/ACCOUNT_ASSIGN_FAILED/);
		expect(owner.activeProcesses()).toEqual({ directory: 1, account: 1 });
		expect(() => acquireOwnership(root, randomUUID())).toThrow(/DATA_DIR_BUSY/);
		expect(await owner.waitRetired(managed, 20)).toBe(false);
		owner.terminate();
		expect(await owner.waitRetired(managed, 5000)).toBe(true);
		managed.close();
	});
	it("denies an assigned child's explicit Windows breakaway attempt", async () => {
		const owner = own(await directory());
		const child = start();
		await message(child);
		const managed = owner.openProcess(child.pid!);
		owner.assign(managed);
		const attempt = once(child, "message");
		child.send({ op: "breakaway", helper: helperPath });
		expect((await attempt)[0]).toEqual({ error: 5 });
		await retire(owner, managed);
	});
	it.each(["directory", "account"])("allows exactly one simultaneous cross-process %s claimant", async (resource) => {
		const root = await directory();
		const other = resource === "directory" ? root : await directory();
		const account = randomUUID();
		const claimants = [start("claim", [root, account]), start("claim", [other, account])];
		const claims = await Promise.all(claimants.map((child) => once(child, "message").then(([value]) => value)));
		expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
		expect(claims.find((claim) => !claim.acquired)?.code).toBe(
			resource === "directory" ? "DATA_DIR_BUSY" : "ACCOUNT_BUSY",
		);
	});
	it("reuses retained empty Jobs for a second launch with a new exact handle", async () => {
		const owner = own(await directory());
		for (let launch = 0; launch < 2; launch++) {
			const child = start();
			const hello = await message(child);
			const managed = owner.openProcess(child.pid!);
			expect(managed.identity).toEqual(hello.identity);
			owner.assign(managed);
			await retire(owner, managed);
		}
	});
	it("fails explicitly with OS detail when ownership is unavailable or a native asset is missing", async () => {
		const root = await directory();
		expect(() => acquireOwnership(join(root, "missing"), randomUUID())).toThrow(
			expect.objectContaining({
				code: "EXECUTOR_OWNERSHIP_UNAVAILABLE",
				cause: expect.objectContaining({ code: "DATA_DIR_OPEN_FAILED" }),
			}),
		);
		const copied = join(root, "platform.ts");
		await copyFile(new URL("../../.uina/worlds/minecraft/executor/platform/index.ts", import.meta.url), copied);
		const probe = start("probe", [copied]);
		expect((await once(probe, "message"))[0]).toEqual({
			code: "EXECUTOR_OWNERSHIP_UNAVAILABLE",
			cause: "MODULE_NOT_FOUND",
		});
	});
});
