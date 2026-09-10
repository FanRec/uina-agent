/**
 * 内核 JobRegistry 只读适配器。
 * 将 JobRegistry 的领域模型转译为 UI TaskDashboard 所需的窄接口。
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
