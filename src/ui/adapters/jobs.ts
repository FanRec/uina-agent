/**
 * 内核 JobRegistry 只读适配器。
 * 将 JobRegistry 的领域模型转译为 UI TaskDashboard 所需的窄接口。
 */

import type { JobRegistry, JobSnapshot, JobRead } from "../../extensions/jobs/registry.js";
import type { JobPort } from "../components/overlays/task-dashboard.js";

export function createJobAdapter(registry: JobRegistry, ownerId = "root"): JobPort {
	return {
		list(): JobSnapshot[] {
			return registry.list(ownerId);
		},
		read(id: string, fromCursor = 0): JobRead {
			return registry.read(id, ownerId, fromCursor);
		},
		cancel(id: string, reason?: string): boolean {
			const res = registry.cancel(id, ownerId, reason);
			return res === "cancellation-requested";
		},
	};
}
