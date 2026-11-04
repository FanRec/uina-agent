/**
 * 纯函数：连接目标解析、Profile 身份、身份文件与旧布局迁移。
 * 不持有活 Executor、不打开 SQLite（v3 §3/§6/§8）。所有写操作只涉及普通文件。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { domainToASCII } from "node:url";

export const MC_PROTOCOL_VERSION = "1.21.11";
export const DEFAULT_PORT = 25565;
export const DEFAULT_SLOT = "default";

/** v3 §4 稳定根布局。executor/runtime/runs/exports 属 Profile；history/library 属共享根。 */
export const LEGACY_FILES = ["executor.db", "runtime.db"] as const;

function invalid(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/** 规范化 host：大小写/尾点/IDNA；不查 DNS、不合并地址；只允许主机/IP。 */
export function canonicalHost(rawHost: string): string {
	const host = rawHost.trim().replace(/\.$/, "");
	if (!host || host.length > 253) throw invalid("INVALID_INPUT", `invalid host ${JSON.stringify(rawHost)}`);
	if (/[\s\\/?:#[\]@]/.test(host) || host.includes("://"))
		throw invalid("INVALID_INPUT", `host must be a bare hostname or IP, got ${JSON.stringify(rawHost)}`);
	// domainToASCII 同时覆盖 IDNA 与普通域名/IP；对合法输入原样返回。
	const ascii = domainToASCII(host);
	return ascii || host.toLowerCase();
}

/** ProfileIdentity 的稳定编码：定长数组避免键序歧义（v3 §3）。 */
export interface ProfileIdentity {
	endpoint: { host: string; port: number };
	principal: { kind: "offline"; username: string; slot: string };
	world: string;
	worldRevision: string;
}

export function profileId(identity: ProfileIdentity): string {
	const { host, port } = identity.endpoint;
	const { kind, username, slot } = identity.principal;
	return createHash("sha256")
		.update(JSON.stringify(["mc-profile-v1", host, port, kind, username, slot, identity.world, identity.worldRevision]))
		.digest("hex");
}

/** 用于拼磁盘路径前校验：profileId 必须是本系统生成的固定格式摘要。 */
export function isProfileId(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

export function profileDir(minecraftRoot: string, id: string): string {
	if (!isProfileId(id)) throw invalid("INVALID_INPUT", `profile id must be a 64-hex digest, got ${JSON.stringify(id)}`);
	return join(minecraftRoot, "sessions", id);
}

/** settings.json：普通文件，每次 connect 重读；缺失等价于 {}。 */
export interface WorldSettings {
	defaultUsername?: string;
	servers?: Record<string, { host: string; port?: number; world?: { id: string; revision?: string } }>;
}

export async function readSettings(path: string): Promise<WorldSettings> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw invalid("SETTINGS_INVALID", `settings unreadable: ${String(error)}`);
	}
	try {
		const value = JSON.parse(raw) as WorldSettings;
		if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value;
	} catch (error) {
		throw invalid("SETTINGS_INVALID", `settings.json is not a valid object: ${String(error)}`);
	}
}

export type ConnectTarget =
	| { host: string; port?: number; username?: string; slot?: string; world?: { id: string; revision?: string } }
	| { server: string; username?: string; slot?: string; world?: { id: string; revision?: string } };

/** world 关联来源：显式声明（工具参数或 settings 具名服务器）才可声称 explicit。 */
export type WorldAssociation = "explicit" | "endpoint_default";

export interface ResolvedTarget {
	identity: ProfileIdentity;
	worldAssociation: WorldAssociation;
	/** 供日志/迁移显示的原始 host 输入；连接一律用 identity.endpoint.host。 */
	source: { host: string; port: number; username: string; slot: string };
}

function worldRef(world: { id: string; revision?: string } | undefined): { world: string; worldRevision: string } {
	if (world == null) throw invalid("INVALID_INPUT", "world binding requires an id");
	if (typeof world.id !== "string" || !world.id.trim()) throw invalid("INVALID_INPUT", "world id must be non-empty");
	if (world.revision !== undefined && (typeof world.revision !== "string" || !world.revision.trim()))
		throw invalid("INVALID_INPUT", "world revision must be non-empty");
	return { world: world.id, worldRevision: world.revision ?? "default" };
}

/** 解析 connect 目标为 Profile 身份；username 缺省只从 settings.defaultUsername 取，不擅自选身份。 */
export function resolveTarget(target: ConnectTarget, settings: WorldSettings): ResolvedTarget {
	let endpoint: { host: string; port: number };
	let aliasWorld: { id: string; revision?: string } | undefined;
	if ("server" in target) {
		// 运行时输入不受联合类型约束；host 与 server 同时出现即拒绝。
		if ("host" in target) throw invalid("INVALID_INPUT", "provide either server alias or host, not both");
		const entry = settings.servers?.[target.server];
		if (!entry?.host) throw invalid("INVALID_INPUT", `unknown server alias ${JSON.stringify(target.server)}`);
		endpoint = { host: canonicalHost(entry.host), port: entry.port ?? DEFAULT_PORT };
		aliasWorld = entry.world;
	} else {
		if (typeof target.host !== "string" || !target.host.trim())
			throw invalid("INVALID_INPUT", "connect requires host or a named server");
		endpoint = { host: canonicalHost(target.host), port: target.port ?? DEFAULT_PORT };
	}
	const username = target.username ?? settings.defaultUsername;
	if (typeof username !== "string" || !username.trim() || username.trim() !== username)
		throw invalid("INVALID_INPUT", "offline username required (parameter or settings.defaultUsername)");
	const slot = target.slot ?? DEFAULT_SLOT;

	// world 关联：显式参数 > settings 具名服务器 > endpoint 约定（不是已证实相同世界）。
	let association: { world: string; worldRevision: string; kind: WorldAssociation };
	if (target.world !== undefined) {
		association = { ...worldRef(target.world), kind: "explicit" };
	} else if (aliasWorld !== undefined) {
		association = { ...worldRef(aliasWorld), kind: "explicit" };
	} else {
		association = {
			world: `endpoint:${endpoint.host}:${endpoint.port}`,
			worldRevision: "default",
			kind: "endpoint_default",
		};
	}
	return {
		identity: {
			endpoint,
			principal: { kind: "offline", username, slot },
			world: association.world,
			worldRevision: association.worldRevision,
		},
		worldAssociation: association.kind,
		source: { host: endpoint.host, port: endpoint.port, username, slot },
	};
}

/** identity.json 不可变：只含 ProfileIdentity 与 schemaVersion（v3 §8）。 */
export interface IdentityFile {
	schemaVersion: 1;
	identity: ProfileIdentity;
}

export interface ObservedFile {
	schemaVersion: 1;
	lastVisit?: {
		visitId: string;
		at: string;
		username: string | null;
		uuid: string | null;
	};
}

export async function readIdentityFile(dir: string): Promise<IdentityFile | null> {
	try {
		const raw = JSON.parse(await readFile(join(dir, "identity.json"), "utf8")) as IdentityFile;
		if (raw?.schemaVersion !== 1 || raw.identity?.principal?.username == null) return null;
		return raw;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw invalid("PROFILE_IDENTITY_INVALID", `identity.json unreadable in ${basename(dir)}: ${String(error)}`);
	}
}

/** 首次建档；重访时内容不一致即拒绝旧 Profile（身份矛盾不由运行时中途改绑）。 */
export async function ensureIdentityFile(dir: string, identity: ProfileIdentity): Promise<IdentityFile> {
	const existing = await readIdentityFile(dir);
	const file: IdentityFile = { schemaVersion: 1, identity };
	if (existing) {
		if (JSON.stringify(existing.identity) !== JSON.stringify(identity))
			throw invalid(
				"PROFILE_IDENTITY_CONFLICT",
				`profile ${basename(dir)} was created for a different identity; choose a new slot or world revision`,
			);
		return existing;
	}
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "identity.json"), `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	return file;
}

export async function readObservedFile(dir: string): Promise<ObservedFile | null> {
	try {
		const raw = JSON.parse(await readFile(join(dir, "observed.json"), "utf8")) as ObservedFile;
		return raw?.schemaVersion === 1 ? raw : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		return null; // 观测文件可再生成；不因可更新观测损坏而拒绝整个 Profile。
	}
}

export async function writeObservedFile(dir: string, observed: ObservedFile): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "observed.json"), `${JSON.stringify(observed, null, "\t")}\n`, "utf8");
}

export interface ProfileSummary {
	profileId: string;
	identity: ProfileIdentity;
	lastSeen: string | null;
	lastUsername: string | null;
}

/** session.list：遍历 identity.json，无登记数据库。 */
export async function listProfiles(minecraftRoot: string): Promise<ProfileSummary[]> {
	const root = join(minecraftRoot, "sessions");
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return [];
	}
	const summaries: ProfileSummary[] = [];
	for (const entry of entries) {
		if (!isProfileId(entry)) continue;
		const dir = join(root, entry);
		const file = await readIdentityFile(dir).catch(() => null);
		if (!file) continue;
		const observed = await readObservedFile(dir);
		summaries.push({
			profileId: entry,
			identity: file.identity,
			lastSeen: observed?.lastVisit?.at ?? null,
			lastUsername: observed?.lastVisit?.username ?? null,
		});
	}
	return summaries.sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
}

/**
 * 一次性旧布局迁移（v3 M4 最小闭环）：稳定根的 executor.db/runtime.db/runs/exports
 * 移入由旧 config.json 身份推出的 sessions/<profileId>/；world-history.db 与 library
 * 留在共享根。带标记可续；身份不可确认或目录被占用时不动旧数据。
 */
export interface MigrationResult {
	migrated: boolean;
	profileId?: string;
	reason?: string;
}

const MIGRATION_MARKER = "migration.json";

/** 旧 config.json → Profile 身份；binding null 的历史分区保留 unbound 字面量（v3 M4 §4）。 */
export function identityFromLegacyConfig(config: unknown): ProfileIdentity | null {
	const c = config as
		| {
				connection?: { host?: string; port?: number; username?: string };
				binding?: { world: string; worldRevision: string } | null;
		  }
		| undefined;
	const connection = c?.connection;
	if (typeof connection?.host !== "string" || typeof connection?.username !== "string" || !connection.username)
		return null;
	return {
		endpoint: { host: canonicalHost(connection.host), port: connection.port ?? DEFAULT_PORT },
		principal: { kind: "offline", username: connection.username, slot: DEFAULT_SLOT },
		world: c?.binding?.world ?? "unbound",
		worldRevision: c?.binding?.worldRevision ?? "unbound",
	};
}

export async function migrateLegacyRoot(minecraftRoot: string, legacyConfig: unknown): Promise<MigrationResult> {
	const rootExecutor = join(minecraftRoot, "executor.db");
	// executor.db 是身份锚点；runtime.db 缺失属早期崩溃的合法旧档，缺什么移什么。
	if (!existsSync(rootExecutor)) return { migrated: false };
	const identity = identityFromLegacyConfig(legacyConfig);
	if (!identity) return { migrated: false, reason: "legacy connection identity unavailable" };
	const id = profileId(identity);
	const target = profileDir(minecraftRoot, id);
	const existing = await readIdentityFile(target);
	if (existing && JSON.stringify(existing.identity) !== JSON.stringify(identity))
		return { migrated: false, reason: "legacy identity conflicts with existing profile" };
	await ensureIdentityFile(target, identity);

	const moves: [string, string][] = [
		[join(minecraftRoot, "runs"), join(target, "runs")],
		[join(minecraftRoot, "exports"), join(target, "exports")],
		[join(minecraftRoot, "runtime.db"), join(target, "runtime.db")],
		[rootExecutor, join(target, "executor.db")],
	];
	const pending = moves.filter(([from]) => existsSync(from));
	if (pending.length) {
		// 标记先行：中断后按同一计划续做（rename 原子；缺源视为已完成）。
		await writeFile(
			join(target, MIGRATION_MARKER),
			`${JSON.stringify({ schemaVersion: 1, profileId: id, pending: pending.map(([from]) => from) }, null, "\t")}\n`,
			"utf8",
		);
		for (const [from, to] of pending) {
			if (existsSync(to)) return { migrated: false, reason: `migration target exists: ${basename(to)}` };
			try {
				await rename(from, to);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") continue; // 已被此前的部分迁移移走。
				// 目录仍被占用（另一 Host 持库）时放弃本次，不半写不损坏。
				return { migrated: false, reason: `legacy data busy: ${code ?? String(error)}` };
			}
		}
	}
	await writeFile(
		join(target, MIGRATION_MARKER),
		`${JSON.stringify({ schemaVersion: 1, profileId: id, completed: true }, null, "\t")}\n`,
		"utf8",
	);
	await writeObservedFile(target, (await readObservedFile(target)) ?? { schemaVersion: 1 });
	return { migrated: true, profileId: id };
}
