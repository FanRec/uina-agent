/**
 * 内核 JobRegistry 的 UI 端口（由组合根注入，不是 UI 自造领域对象）。
 *
 * - 读取（list/read）走宿主视图：面板要展示包括项目扩展启动在内的全部 Job。
 * - 取消（cancel）是面板上的用户动作，端口只把它转译为一次领域请求，
 *   不在 UI 里另存任何任务状态。
 */

import type { JobRegistry, JobSnapshot, JobRead } from "../../extensions/jobs/registry.js";
import type { JobPort } from "../components/overlays/task-dashboard.js";

/** The host UI owns every job, including jobs started by project extensions,
 * so it deliberately reads without an owner filter. */
export function createJobAdapter(registry: JobRegistry): JobPort {
	return {
		list(): JobSnapshot[] {
			return registry.list();
		},
		read(id: string, fromCursor = 0): JobRead {
			return registry.read(id, undefined, fromCursor);
		},
		cancel(id: string, reason?: string): boolean {
			const res = registry.cancel(id, undefined, reason);
			return res === "cancellation-requested";
		},
	};
}
