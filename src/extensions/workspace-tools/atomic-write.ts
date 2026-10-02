import { randomUUID } from "node:crypto";
import { rm, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(
	file: string,
	data: string | Uint8Array,
	// 交叉 signal 用于收窄 writeFile 的重载联合（排除纯字符串编码分支）
	options: Parameters<typeof writeFile>[2] & { signal?: AbortSignal },
): Promise<void> {
	const temp = join(dirname(file), `.${randomUUID()}.uina-tmp`);
	try {
		await writeFile(temp, data, options);
		if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
		await rename(temp, file);
	} finally {
		await rm(temp, { force: true }).catch(() => undefined);
	}
}
