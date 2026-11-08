/**
 * Addon 依赖版本范围：语义交给成熟 `semver` 实现，本仓库不重写比较器。
 *
 * `semver@7` 不带 TypeScript 声明，这里按项目既有做法（见 executor/protocol.ts 的 Ajv）
 * 用 createRequire 装载并收窄到实际用到的三个函数，不引入额外类型依赖。
 */

import { createRequire } from "node:module";

interface SemverApi {
	valid(version: string): string | null;
	validRange(range: string): string | null;
	satisfies(version: string, range: string): boolean;
}

const semver = createRequire(import.meta.url)("semver") as SemverApi;

export function isValidVersion(version: string): boolean {
	return typeof version === "string" && semver.valid(version) != null;
}

/** `""` 不是合法范围；`*` / `^1.0.0` / `>=2 <3` / 精确版本都可以。 */
export function isValidRange(range: string): boolean {
	return typeof range === "string" && range.length > 0 && semver.validRange(range) != null;
}

export function versionSatisfies(version: string, range: string): boolean {
	return semver.satisfies(version, range);
}
