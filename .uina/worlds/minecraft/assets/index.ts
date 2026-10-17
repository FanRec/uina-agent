/**
 * Assets 模块公共入口（实现归 Assets 开发 AI；接缝为 contracts/assets.ts 新合同）。
 *
 * 职责（docs/proposals/mc/modules/assets.md 2026-10-17）：三类资产唯一仓库、
 * publish（workspace/import/run 段）CAS 与操作账本、受管不可变修订包、
 * ReadLibrary/WriteLibrary 冻结视图、Evidence 独立关联。
 *
 * 边界：不执行代码、不控制 Bot、不保存执行栈；Runtime 材料经注入的
 * ProgramSourcePort/EvidenceExportPort 导出，端口未注入时显式失败，不伪造能力。
 *
 * 存储形态：node:sqlite 目录（catalog.sqlite）+ 普通文件包（objects/、tmp/）。
 * 目录打不开（损坏/版本不兼容）时直接抛错——Assets 没有降级形态，
 * 由组合根决定故障处置（assets.md §7.3：数据库不可读时不靠文件树推断提交历史）。
 */

import type { ProgramSourcePort, ReadLibrary, WriteLibrary } from "../contracts/assets.js";
import { AssetCatalog } from "./internal/catalog.js";
import { AssetObjectStore } from "./internal/objects.js";
import {
	type AssetRepositoryDepsInternal,
	AssetRepositoryImpl,
	readLibraryView,
	writeLibraryView,
} from "./internal/repository.js";

export interface AssetRepositoryDeps {
	/** Assets 数据目录（由接入层从 worldDataDir 注入）。 */
	readonly dataDir: string;
	/** 宿主绑定的读取根；workspace 来源目录必须留在根内（assets.md §5.2）。 */
	readonly workspaceRoot: string;
	/** 稳定调用者身份（assets.md §5.2 Principal）；缺省 "host"。 */
	readonly ownerId?: string;
	/** Runtime 的可信段导出口；未注入前 publishFromRun 显式失败（不伪造 Runtime 能力）。 */
	readonly programSource?: ProgramSourcePort;
	/** 可信证据导出口与归属路由；未注入前 attachEvidence 显式失败。 */
	readonly evidencePorts?: {
		resolveOwner(sourceRef: string): "runtime" | "world" | null;
		runtime?: import("../contracts/assets.js").EvidenceExportPort;
		world?: import("../contracts/assets.js").EvidenceExportPort;
	};
}

export interface AssetRepositoryHandle {
	readonly catalog: AssetCatalog;
	/** 唯一业务实现（宿主内部；不交给脚本）。 */
	readonly repository: AssetRepositoryImpl;
	/** read Callable 视图：只含 ReadLibrary 方法的冻结包装。 */
	readonly read: ReadLibrary;
	/** act Callable 视图：WriteLibrary 冻结包装；写入口每次准入核验 scope。 */
	readonly write: WriteLibrary;
	close(): Promise<void>;
}

export function createAssetRepository(deps: AssetRepositoryDeps): AssetRepositoryHandle {
	const internal: AssetRepositoryDepsInternal = {
		catalog: new AssetCatalog(deps.dataDir),
		store: new AssetObjectStore(deps.dataDir),
		workspaceRoot: deps.workspaceRoot,
		ownerId: deps.ownerId,
		programSource: deps.programSource,
		evidencePorts: deps.evidencePorts,
	};
	const repository = new AssetRepositoryImpl(internal.catalog, internal.store, internal);
	return {
		catalog: internal.catalog,
		repository,
		read: readLibraryView(repository),
		write: writeLibraryView(repository),
		close: () => repository.close(),
	};
}
