/**
 * Assets 模块公共入口（实现归 Assets 开发 AI；本文件签名是模块接缝）。
 *
 * 职责（docs/proposals/mc/modules/assets.md）：三类资产唯一仓库、版本/头/CAS、
 * 请求账本、受管不可变字节对象、强证据保留（经注入的证据端口）。
 *
 * 边界：不获取 Bot、不调用 submit、不读 Runtime/World 业务表；
 * 证据保留经注入的 WorldEvidencePort/RuntimeEvidencePort 完成。
 */

import type { AssetRepository, AssetObjectPort } from "../contracts/assets.js";
import type { RuntimeEvidencePort } from "../contracts/executor.js";
import type { WorldEvidencePort } from "../contracts/world.js";

export interface AssetRepositoryDeps {
	/** Assets 数据目录（由接入层从 worldDataDir 注入）。 */
	readonly dataDir: string;
	readonly worldEvidence?: WorldEvidencePort;
	readonly runtimeEvidence?: RuntimeEvidencePort;
}

export interface AssetRepositoryHandle extends AssetRepository {
	/** 仅注入可信的持久发布/导入导出所有者。 */
	readonly objects: AssetObjectPort;
	close(): Promise<void>;
}

export function createAssetRepository(_deps: AssetRepositoryDeps): AssetRepositoryHandle {
	throw new Error("未实现：Assets 切片待 Assets 开发 AI 交付（保持本签名）");
}
