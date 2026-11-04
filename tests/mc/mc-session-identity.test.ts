/** Profile 身份纯函数与旧布局迁移（v3 §3/§4/§8）。 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	canonicalHost,
	ensureIdentityFile,
	type IdentityFile,
	identityFromLegacyConfig,
	isProfileId,
	type ProfileIdentity,
	listProfiles,
	migrateLegacyRoot,
	profileDir,
	profileId,
	readIdentityFile,
	readObservedFile,
	readSettings,
	resolveTarget,
	writeObservedFile,
} from "../../.uina/worlds/minecraft/worlddef/session-identity.js";

function code(run: () => unknown): string {
	try {
		run();
		return "no error";
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
}

test("canonicalHost normalizes case, trailing dot and IDNA without inventing addresses", () => {
	expect(canonicalHost("MC.Example.COM.")).toBe("mc.example.com");
	expect(canonicalHost("127.0.0.1")).toBe("127.0.0.1");
	expect(canonicalHost("中国.example")).toBe("xn--fiqs8s.example");
	expect(() => canonicalHost("http://mc.example.net")).toThrow();
	expect(() => canonicalHost("mc.example.net/path")).toThrow();
	expect(() => canonicalHost("mc example")).toThrow();
});

test("profileId is deterministic and separates endpoint, username case, slot and world revision", () => {
	const base = {
		endpoint: { host: "mc.example.net", port: 25565 },
		principal: { kind: "offline" as const, username: "Uina", slot: "default" },
		world: "survival",
		worldRevision: "r1",
	};
	expect(profileId(base)).toBe(profileId({ ...base }));
	expect(isProfileId(profileId(base))).toBe(true);
	// 同服不同离线用户名是不同 Profile（T04），账号 Job 键的小写化不属于身份。
	expect(profileId(base)).not.toBe(profileId({ ...base, principal: { ...base.principal, username: "uina" } }));
	expect(profileId(base)).not.toBe(profileId({ ...base, endpoint: { ...base.endpoint, port: 25566 } }));
	expect(profileId(base)).not.toBe(profileId({ ...base, worldRevision: "r2" }));
	expect(profileId(base)).not.toBe(profileId({ ...base, principal: { ...base.principal, slot: "s2" } }));
});

test("profileDir rejects values that are not system-minted digests before touching the disk", () => {
	expect(() => profileDir("/root", "../escape")).toThrow();
	expect(() => profileDir("/root", "keys")).toThrow();
});

test("resolveTarget falls back to settings defaults and marks world association honestly", () => {
	const settings = {
		defaultUsername: "Uina",
		servers: { home: { host: "MC.Home.NET.", port: 25566, world: { id: "home-save", revision: "r1" } } },
	};
	const byHost = resolveTarget({ host: "mc.Example.net" }, settings);
	expect(byHost.identity).toEqual({
		endpoint: { host: "mc.example.net", port: 25565 },
		principal: { kind: "offline", username: "Uina", slot: "default" },
		world: "endpoint:mc.example.net:25565",
		worldRevision: "default",
	});
	expect(byHost.worldAssociation).toBe("endpoint_default");

	const byAlias = resolveTarget({ server: "home" }, settings);
	expect(byAlias.identity.endpoint).toEqual({ host: "mc.home.net", port: 25566 });
	expect(byAlias.worldAssociation).toBe("explicit");
	expect(byAlias.identity.world).toBe("home-save");

	const explicit = resolveTarget({ host: "mc.example.net", username: "Alt", world: { id: "s2" } }, settings);
	expect(explicit.identity).toMatchObject({ principal: { username: "Alt" }, world: "s2", worldRevision: "default" });
	expect(explicit.worldAssociation).toBe("explicit");

	expect(code(() => resolveTarget({ host: "mc.example.net" }, {}))).toBe("INVALID_INPUT");
	expect(code(() => resolveTarget({ host: "mc.example.net", server: "home" }, settings))).toBe("INVALID_INPUT");
	expect(code(() => resolveTarget({ server: "missing" }, settings))).toBe("INVALID_INPUT");
});

test("settings.json is optional and rejects malformed JSON loudly", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-identity-"));
	try {
		expect(await readSettings(join(root, "settings.json"))).toEqual({});
		await writeFile(join(root, "settings.json"), "{oops", "utf8");
		await expect(readSettings(join(root, "settings.json"))).rejects.toMatchObject({ code: "SETTINGS_INVALID" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("identity.json is immutable per profile; observed.json is updatable", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-identity-"));
	try {
		const identity: ProfileIdentity = {
			endpoint: { host: "mc.example.net", port: 25565 },
			principal: { kind: "offline", username: "Uina", slot: "default" },
			world: "survival",
			worldRevision: "r1",
		};
		const dir = profileDir(root, profileId(identity));
		await ensureIdentityFile(dir, identity);
		const file: IdentityFile | null = await readIdentityFile(dir);
		expect(file?.identity).toEqual(identity);
		await expect(ensureIdentityFile(dir, { ...identity, worldRevision: "r2" })).rejects.toMatchObject({
			code: "PROFILE_IDENTITY_CONFLICT",
		});
		// 冲突不掩盖：文件内容保持原身份。
		expect(JSON.parse(await readFile(join(dir, "identity.json"), "utf8"))).toMatchObject({
			identity: { worldRevision: "r1" },
		});
		await writeObservedFile(dir, {
			schemaVersion: 1,
			lastVisit: { visitId: "visit:1", at: "2026-11-05T00:00:00Z", username: "Uina", uuid: null },
		});
		expect(await readObservedFile(dir)).toMatchObject({ lastVisit: { visitId: "visit:1" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listProfiles scans identity.json files, ignores foreign entries and sorts by last visit", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-identity-"));
	try {
		const identity = (world: string) => ({
			endpoint: { host: "mc.example.net", port: 25565 },
			principal: { kind: "offline" as const, username: "Uina", slot: "default" },
			world,
			worldRevision: "r1",
		});
		const a = profileDir(root, profileId(identity("a")));
		const b = profileDir(root, profileId(identity("b")));
		await ensureIdentityFile(a, identity("a"));
		await ensureIdentityFile(b, identity("b"));
		await writeObservedFile(a, {
			schemaVersion: 1,
			lastVisit: { visitId: "v", at: "2026-11-01T00:00:00Z", username: "Uina", uuid: null },
		});
		await writeObservedFile(b, {
			schemaVersion: 1,
			lastVisit: { visitId: "v", at: "2026-11-02T00:00:00Z", username: "Uina", uuid: null },
		});
		await mkdir(join(root, "sessions", "not-a-profile"), { recursive: true });
		const profiles = await listProfiles(root);
		expect(profiles.map((p) => p.identity.world)).toEqual(["b", "a"]);
		expect(profiles[0]).toMatchObject({ lastSeen: "2026-11-02T00:00:00Z", lastUsername: "Uina" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const legacyConfig = {
	connection: { host: "127.0.0.1", port: 25565, username: "UinaDev", authMode: "offline", version: "1.21.11" },
	binding: { world: "home-save", worldRevision: "r1" } as { world: string; worldRevision: string } | null,
};

async function seedLegacyRoot(root: string): Promise<void> {
	await mkdir(join(root, "runs", "run-1", "sources"), { recursive: true });
	await mkdir(join(root, "exports", "images"), { recursive: true });
	await writeFile(join(root, "executor.db"), "executor-bytes", "utf8");
	await writeFile(join(root, "runtime.db"), "runtime-bytes", "utf8");
	await writeFile(join(root, "runs", "run-1", "sources", "a.js"), "source", "utf8");
	await writeFile(join(root, "world-history.db"), "history-stays", "utf8");
}

test("migrateLegacyRoot moves profile-owned files under the config-derived identity and keeps shared roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-migrate-"));
	try {
		await seedLegacyRoot(root);
		const result = await migrateLegacyRoot(root, legacyConfig);
		expect(result.migrated).toBe(true);
		const identity = identityFromLegacyConfig(legacyConfig)!;
		const target = profileDir(root, profileId(identity));
		expect(existsSync(join(target, "executor.db"))).toBe(true);
		expect(existsSync(join(target, "runtime.db"))).toBe(true);
		expect(existsSync(join(target, "runs", "run-1", "sources", "a.js"))).toBe(true);
		expect(existsSync(join(target, "exports", "images"))).toBe(true);
		// 共享根不动：历史库与 library 仍在原位；稳定根不再有 executor.db。
		expect(existsSync(join(root, "world-history.db"))).toBe(true);
		expect(existsSync(join(root, "executor.db"))).toBe(false);
		expect(await readFile(join(target, "executor.db"), "utf8")).toBe("executor-bytes");
		expect(await readIdentityFile(target)).toMatchObject({ identity });
		expect((await readObservedFile(target))?.schemaVersion).toBe(1);
		// 重复执行幂等：身份锚点已不在根上即无事可做，目标内容原样保留。
		expect(await migrateLegacyRoot(root, legacyConfig)).toMatchObject({ migrated: false });
		expect(existsSync(join(target, "executor.db"))).toBe(true);
		expect(await readFile(join(target, "executor.db"), "utf8")).toBe("executor-bytes");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("migrateLegacyRoot keeps unbound history unassociated and refuses incomplete or conflicting legacy data", async () => {
	const unbound = { ...legacyConfig, binding: null };
	expect(identityFromLegacyConfig(unbound)).toMatchObject({ world: "unbound", worldRevision: "unbound" });

	const noIdentity = await mkdtemp(join(tmpdir(), "uina-mc-migrate-"));
	try {
		await seedLegacyRoot(noIdentity);
		expect(await migrateLegacyRoot(noIdentity, undefined)).toMatchObject({
			migrated: false,
			reason: "legacy connection identity unavailable",
		});
		expect(existsSync(join(noIdentity, "executor.db"))).toBe(true);
	} finally {
		await rm(noIdentity, { recursive: true, force: true });
	}

	// executor.db 无 runtime.db：早期崩溃的合法旧档（Runtime 尚未创建），缺什么移什么。
	const partial = await mkdtemp(join(tmpdir(), "uina-mc-migrate-"));
	try {
		await mkdir(partial, { recursive: true });
		await writeFile(join(partial, "executor.db"), "executor-bytes", "utf8");
		const partialResult = await migrateLegacyRoot(partial, legacyConfig);
		expect(partialResult.migrated).toBe(true);
		const partialTarget = profileDir(partial, profileId(identityFromLegacyConfig(legacyConfig)!));
		expect(existsSync(join(partialTarget, "executor.db"))).toBe(true);
		expect(existsSync(join(partialTarget, "runtime.db"))).toBe(false);
	} finally {
		await rm(partial, { recursive: true, force: true });
	}
});

test("migrateLegacyRoot resumes an interrupted migration to the same identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-migrate-"));
	try {
		await seedLegacyRoot(root);
		const identity = identityFromLegacyConfig(legacyConfig)!;
		const target = profileDir(root, profileId(identity));
		await mkdir(target, { recursive: true });
		// 模拟中断：runtime.db 已移走，executor.db 留在根上。
		await rename(join(root, "runtime.db"), join(target, "runtime.db"));
		const result = await migrateLegacyRoot(root, legacyConfig);
		expect(result.migrated).toBe(true);
		expect(existsSync(join(target, "executor.db"))).toBe(true);
		expect(existsSync(join(root, "executor.db"))).toBe(false);
		expect(existsSync(join(target, "runs", "run-1", "sources", "a.js"))).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
