/**
 * 跨层共享的最小错误工具。agent、extensions、host、tools 都会产生「把未知错误
 * 变成可读文本」的需求；这里只有一份实现，避免 16 份拷贝各自漂移。
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
