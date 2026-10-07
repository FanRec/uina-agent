import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 媒体资源根校验（G8 边界本体）：模型给出的文件路径必须落在部署允许根内。
 * 校验链：绝对化 → realpath（解析 junction/symlink 到真实路径）→ 逐根前缀比对。
 * 拒绝：`..` 逃逸、根外 symlink/junction 指向、未允许盘符/UNC、不存在路径。
 * 这不是内容保密/数据防外发系统——只保证 QQ 上传的文件来自部署者声明的根。
 */

export interface MediaRootOptions {
	/** 允许根（绝对路径）；部署者显式声明，缺省由装配层给 [cwd, worldDataDir]。 */
	readonly allowedRoots: readonly string[];
}

export type MediaPathCheck =
	| { readonly ok: true; readonly realPath: string; readonly root: string }
	| { readonly ok: false; readonly reason: "not_absolute" | "traversal" | "not_found" | "not_file" | "outside_roots" | "no_roots"; readonly detail: string };

/** 规范化允许根：realpath（根不存在时跳过该根并报告）。 */
export function normalizeRoots(roots: readonly string[]): { real: string[]; skipped: string[] } {
	const real: string[] = [];
	const skipped: string[] = [];
	for (const root of roots) {
		if (!isAbsolute(root)) {
			skipped.push(root);
			continue;
		}
		try {
			real.push(withTrailingSep(realpathSync(resolve(root))));
		} catch {
			skipped.push(root);
		}
	}
	return { real, skipped };
}

function withTrailingSep(path: string): string {
	return path.endsWith(sep) ? path : path + sep;
}

/** 校验单个模型提供路径；任何逃逸明确失败（不静默跳过该分段）。 */
export function checkMediaPath(input: string, options: MediaRootOptions): MediaPathCheck {
	if (options.allowedRoots.length === 0) {
		return { ok: false, reason: "no_roots", detail: "未配置任何允许根；媒体发送未启用" };
	}
	if (!isAbsolute(input)) {
		return { ok: false, reason: "not_absolute", detail: `路径必须是绝对路径: ${input}` };
	}
	// 必须检查原始分段；resolve 会折叠 ..，之后再检查已经太迟。
	if (input.split(/[\\/]/).includes("..")) {
		return { ok: false, reason: "traversal", detail: `路径包含 .. 逃逸: ${input}` };
	}
	const resolved = resolve(input);
	let realPath: string;
	try {
		realPath = realpathSync(resolved);
		if (!statSync(realPath).isFile()) return { ok: false, reason: "not_file", detail: "媒体资源必须是普通文件" };
	} catch {
		return { ok: false, reason: "not_found", detail: `路径不存在或不可访问: ${input}` };
	}
	const { real } = normalizeRoots(options.allowedRoots);
	for (const root of real) {
		const rel = relative(root, realPath);
		if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)) {
			return { ok: true, realPath, root: root.slice(0, -1) };
		}
	}
	// realpath 后仍不在根内 = symlink/junction 指向根外
	return { ok: false, reason: "outside_roots", detail: `真实路径 ${realPath} 不在任何允许根内（含 junction/symlink 越界）` };
}

/** Windows/POSIX 统一的 file:// URI（三斜杠 + 正斜杠 + 盘符保留）。 */
export function toFileUri(realPath: string): string {
	return pathToFileURL(realPath).href;
}
