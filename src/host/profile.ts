/**
 * SubjectProfile：主体身份、资源根解析与进程级独占锁（认知扩展阶段 A / M1）。
 *
 * 不变量：
 * 1. subjectId ↔ 目录绑定不可变：profile.json 的 subjectId 必须与目录名一致；
 * 2. 路径解析抗目录穿越：所有资源根 resolve 后必须位于 subjectsRoot 之内；
 * 3. 一个数据根恰好一个活动写入进程：wx 排他锁 + ownerToken/PID；
 *    锁存在即拒绝启动，明确报错——不自动偷锁（PID 可能被复用，时间过期不可靠）。
 *
 * profileArg 缺省时 resolveProfile 返回 undefined：调用方走原有路径解析，
 * 全部行为与 profile 机制引入前逐字节一致。
 */

import { existsSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SubjectProfileIdentity {
	readonly subjectId: string;
	readonly displayName: string;
	readonly templateVersion?: string;
}

export interface SubjectProfileResources {
	readonly workspace: string;
	readonly memoryRoot: string;
	readonly stateRoot: string;
	readonly appDataRoot: string;
	readonly cacheRoot: string;
}

export interface SubjectProfileSessions {
	readonly sessionId: string;
	readonly journalPath: string;
}

/** 不可变装配结果：Host 启动时解析一次，此后只读。 */
export interface SubjectProfile {
	readonly identity: SubjectProfileIdentity;
	readonly personaText: string;
	readonly resources: SubjectProfileResources;
	readonly sessions: SubjectProfileSessions;
	/** settings.json 所在目录（loadSettings/saveSettings 的 home 形参数）。 */
	readonly settingsDir: string;
	/** profile 数据根（subjectsRoot/<subjectId>）。 */
	readonly root: string;
}

export interface ResolveProfileOptions {
	/** CLI --profile 的值；undefined/空 = 不启用 profile（返回 undefined）。 */
	profileArg?: string;
	/** 组合根工作目录；subjectsRoot 默认 <cwd>/profiles。 */
	cwd: string;
}

interface ProfileJson {
	subjectId?: unknown;
	displayName?: unknown;
}

const SUBJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

function assertValidSubjectId(id: string): void {
	if (!SUBJECT_ID_PATTERN.test(id)) {
		throw new Error(
			`非法 subjectId "${id}"：仅允许小写字母/数字/短横线/下划线，长度 1-64，且以字母或数字开头。`,
		);
	}
}

/** 解析后的路径必须仍在 root 内（防目录穿越）。返回规范化绝对路径。 */
function contained(root: string, ...segments: string[]): string {
	const resolved = resolve(root, ...segments);
	const rel = relative(root, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`路径越界：${resolved} 不在主体根 ${root} 之内。`);
	}
	return resolved;
}

/** 排他锁文件名。 */
const LOCK_FILE = "host.lock";

interface LockPayload {
	ownerToken: string;
	pid: number;
	acquiredAt: string;
}

/** 释放锁：仅当锁内容与自己写入的 ownerToken 一致时删除——不删后来进程的锁。 */
export async function releaseProfileLock(profile: SubjectProfile): Promise<void> {
	const lockPath = join(profile.resources.stateRoot, LOCK_FILE);
	const ownToken = profileOwnerToken(profile);
	if (!ownToken) return; // 非 Holder 释放（如重启后重建的 profile 对象）：不碰锁
	let payload: LockPayload;
	try {
		payload = JSON.parse(readFileSync(lockPath, "utf8")) as LockPayload;
	} catch {
		return; // 锁已不存在或不可读：视为已释放
	}
	if (!payload || payload.ownerToken !== ownToken) return;
	try {
		unlinkSync(lockPath);
	} catch {
		// Windows 上句柄延迟可能导致 unlink 失败：锁残留会阻止下次启动，错误可见优于静默。
	}
}

/** SubjectProfile 的 ownerToken 是运行时字段（不序列化进 profile.json，WeakMap 持有保持视图不可变）。 */
const lockTokens = new WeakMap<SubjectProfile, string>();

export function profileOwnerToken(profile: SubjectProfile): string | undefined {
	return lockTokens.get(profile);
}

/**
 * 解析主体 profile。profileArg 缺省返回 undefined（调用方走原有路径）。
 *
 * 副作用（仅在合法解析时）：创建目录结构；取得排他锁。
 * 锁与返回的 profile 绑定：用 releaseProfileLock(profile) 释放。
 */
export function resolveProfile(options: ResolveProfileOptions): SubjectProfile | undefined {
	const profileArg = options.profileArg?.trim();
	if (!profileArg) return undefined;

	assertValidSubjectId(profileArg);

	const subjectsRoot = resolve(options.cwd, "profiles");
	const root = contained(subjectsRoot, profileArg);

	const jsonPath = join(root, "profile.json");
	if (!existsSync(jsonPath)) {
		throw new Error(`profile.json 不存在：${jsonPath}。请先创建主体目录与配置。`);
	}
	let parsed: ProfileJson;
	try {
		// 容忍 Windows 编辑器写入的 UTF-8 BOM（\uFEFF）：JSON.parse 不接受 BOM 头。
		const rawJson = readFileSync(jsonPath, "utf8").replace(/^\uFEFF/, "");
		parsed = JSON.parse(rawJson) as ProfileJson;
	} catch (error) {
		throw new Error(`profile.json 不是合法 JSON（${jsonPath}）：${String(error)}`);
	}
	if (typeof parsed.subjectId !== "string" || parsed.subjectId !== profileArg) {
		throw new Error(
			`profile.json 的 subjectId（${String(parsed.subjectId)}）必须与目录名（${profileArg}）一致，拒绝绑定。`,
		);
	}
	const displayName = typeof parsed.displayName === "string" ? parsed.displayName : profileArg;

	const memoryRoot = contained(root, "memory");
	const stateRoot = contained(root, "state");
	const appDataRoot = contained(root, "app-data");
	const cacheRoot = contained(root, "cache");
	const sessionsDir = contained(root, "sessions");
	for (const dir of [memoryRoot, stateRoot, appDataRoot, cacheRoot, sessionsDir]) {
		mkdirSync(dir, { recursive: true });
	}

	const personaPath = join(root, "persona.md");
	const personaText = existsSync(personaPath) ? readFileSync(personaPath, "utf8") : "";

	// 排他锁：wx 创建失败 = 已有活动进程持有该数据根。
	const lockPath = join(stateRoot, LOCK_FILE);
	const ownerToken = randomUUID();
	const payload: LockPayload = { ownerToken, pid: process.pid, acquiredAt: new Date().toISOString() };
	try {
		const fd = openSync(lockPath, "wx");
		writeFileSync(fd, JSON.stringify(payload, null, "\t"));
		closeSync(fd);
	} catch (error) {
		throw new Error(
			`主体数据根已被占用（${lockPath}）。若确认没有其他进程在运行（检查 PID 后删除该文件可恢复），否则请先停止已运行的实例。原始错误：${String(error)}`,
		);
	}

	const profile: SubjectProfile = {
		identity: { subjectId: profileArg, displayName },
		personaText,
		resources: { workspace: resolve(options.cwd), memoryRoot, stateRoot, appDataRoot, cacheRoot },
		sessions: { sessionId: "default", journalPath: join(sessionsDir, "session.jsonl") },
		settingsDir: root,
		root,
	};
	lockTokens.set(profile, ownerToken);
	return profile;
}
