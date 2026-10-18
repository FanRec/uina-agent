/**
 * 环境快照（代次三元组 + 模型身份）：连接、模型载入、目录。
 *
 * 任何一项变化，此前捕获的外部状态（位姿基线、染色、后处理、在途 ACK）都不再可信。
 * 这类判定原来散在 `sameModel()`、`restore()`、`runCostume()`、`runtime.tick` 的身份门里各写一遍，
 * 漏写一处的后果是把旧位姿写到新模型上——所以收成一个显式快照，让"忘记检查"变成类型上做不到。
 */
export interface EnvironmentToken {
	/** 连接代次：每次握手/重连/断线 +1。 */
	readonly connection: number;
	/** 模型载入代次：VTS 每次换模型 +1。 */
	readonly model: number;
	/** 目录代次：reload 或换目录 +1。 */
	readonly catalog: number;
	/** 当前载入模型的 VTS 身份；未连接/未载入时为 null。 */
	readonly modelID: string | null;
}

export function sameEnvironment(a: EnvironmentToken, b: EnvironmentToken): boolean {
	return a.connection === b.connection && a.model === b.model && a.catalog === b.catalog && a.modelID === b.modelID;
}

/** 描述"哪一拍变了"，用于 unknown/rejected 的原因正文。 */
export function describeEnvironmentChange(before: EnvironmentToken, after: EnvironmentToken): string {
	const changed: string[] = [];
	if (before.connection !== after.connection) changed.push(`connection ${before.connection}→${after.connection}`);
	if (before.model !== after.model) changed.push(`model ${before.model}→${after.model}`);
	if (before.catalog !== after.catalog) changed.push(`catalog ${before.catalog}→${after.catalog}`);
	if (before.modelID !== after.modelID) changed.push(`modelID ${before.modelID ?? "none"}→${after.modelID ?? "none"}`);
	return changed.length === 0 ? "环境未变化" : changed.join("; ");
}
