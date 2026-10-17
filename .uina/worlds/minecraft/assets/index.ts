/**
 * Assets 模块公共入口（实现归 Assets 开发 AI；本文件签名是模块接缝）。
 *
 * 职责（docs/proposals/mc/modules/assets.md）：三类资产唯一仓库、版本/头/CAS、
 * 请求账本、受管不可变字节对象、强证据保留（经注入的证据端口）。
 *
 * 边界：不获取 Bot、不调用 submit、不读 Runtime/World 业务表；
 * 证据保留经注入的 WorldEvidencePort/RuntimeEvidencePort 完成。
 *
 * 存储形态：node:sqlite 目录（catalog.sqlite）+ 普通文件包（objects/、tmp/）。
 * 目录打不开（损坏/版本不兼容）时直接抛错——Assets 没有降级形态，
 * 由组合根决定故障处置（assets.md §7.3：数据库不可读时不靠文件树推断提交历史）。
 */

import { AssetCatalog } from "./internal/catalog.js";
import { AssetObjectStore } from "./internal/objects.js";
import { AssetRepositoryImpl } from "./internal/repository.js";
import type { AssetObjectPort, AssetRepository } from "../contracts/assets.js";
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

export function createAssetRepository(deps: AssetRepositoryDeps): AssetRepositoryHandle {
	const objects = new AssetObjectStore(deps.dataDir);
	const catalog = new AssetCatalog(deps.dataDir);
	return new AssetRepositoryImpl(catalog, objects, deps.worldEvidence, deps.runtimeEvidence);
}
