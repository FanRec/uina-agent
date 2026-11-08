/** Executor/Companion wire values. Owner and execution facts stay with Runtime. */
import type { AddonSelection, AddonStatus } from "./addons.js";
import type { ControlRetirement, Origin, OwnerState } from "./runtime.js";
import type { JsonValue, Ref } from "./values.js";
import type { WorldAvailabilityValue } from "./world.js";

export interface ExecutorConfig {
	connection: { host: string; port: number; username: string; authMode: "offline"; version?: string };
	binding: { world: Ref; worldRevision: Ref } | null;
}

export interface CompanionInit {
	launch: Ref;
	origin: Origin;
	storageId: Ref;
	/** 本 Profile 的 runtime.db/runs/exports 根；executor.db 所在目录。 */
	sessionDataDir: string;
	/** world-history.db 与 library/ 的共享根（跨 Profile 只读复用）。 */
	sharedDataDir: string;
	config: ExecutorConfig;
	/** 本次连接冻结的 Addon 装配计划；缺省 = 未启用任何包。 */
	addons?: AddonSelection;
	unclean: boolean;
	oldControlRetired: boolean;
	ownerLifetimeMs: number;
	localGates: ("disabled" | "emergency" | "owner_lost")[];
}

/** 退役三事实（v3 §6.2）：只允许新执行域的必要条件是 process=retired && ownership=released。 */
export interface ExecutorCloseResult {
	/** 所有受管进程是否确认退出。 */
	process: "retired" | "unknown";
	/** 目录 Native Job 是否释放。 */
	ownership: "released" | "held";
	/** 只决定旧记录如何恢复/审计，不阻止切服。 */
	runtime: "clean" | "unclean" | "unknown";
}

/** connection.wait 的入服终态快照：连接状态、观测到的登录身份与断开原因。 */
export interface ConnectionWaitResult {
	state: ExecutionSideStatus["connection"];
	username: string | null;
	/** 服务器登录会话给出的玩家 UUID；拿不到可靠来源就保持 null，不冒充已核对。 */
	uuid: string | null;
	reason: string | null;
}

export type RetirementRequest = ControlRetirement & { launch: Ref };

export interface ExecutionSideStatus {
	launch: Ref;
	storageId: Ref;
	observedAt: string;
	authMode: "offline";
	owner: OwnerState | null;
	connection: "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	world: WorldAvailabilityValue;
	runtime: "ready" | "unavailable";
	safety: { active: Ref | null; last: Ref | null };
	program: import("./program.js").ProgramCapacity | null;
	faults: { code: string; message: string }[];
	/** 本次装配的 Addon 状态（Loaded 事实；不是服务端安装事实）。 */
	addons: AddonStatus[];
	/** 包内静态知识与注册表的冲突（注册表优先，冲突显式记录）。 */
	addonConflicts: string[];
	retirement: RetirementRequest | null;
}

export interface WireError {
	code: string;
	message: string;
	failure?: JsonValue;
	detail?: JsonValue;
}

export interface GameNotice {
	ref: string;
	observedAt: string;
	payload: JsonValue;
}

export type ExecutorFrame =
	| { v: 1; launch: Ref; kind: "request"; id: number; method: string; payload: JsonValue }
	| {
			v: 1;
			launch: Ref;
			kind: "reply";
			id: number;
			method: string;
			result: { ok: true; value: JsonValue } | { ok: false; error: WireError };
	  }
	| { v: 1; launch: Ref; kind: "cancel_wait"; id: number }
	| { v: 1; launch: Ref; kind: "retire_required"; request: RetirementRequest }
	| {
			v: 1;
			launch: Ref;
			kind: "changed";
			runs: { run: Ref; revision: number }[];
			statusChanged: boolean;
			events?: GameNotice[];
	  };

export interface BootstrapHello {
	v: 1;
	kind: "hello";
	launch: Ref;
	pid: number;
	createdAt: string;
}
