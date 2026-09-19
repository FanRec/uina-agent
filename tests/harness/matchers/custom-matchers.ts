import { expect } from "vitest";
import type { UinaTestHarness } from "../host/harness.js";
import { assertDAGInvariants, assertNoResourceLeaks } from "./invariants.js";

interface CustomMatchers<R = unknown> {
	toConformToDAG(): R;
	toHaveNoLeakedResources(): R;
	toHaveTurnCompleted(turnNumber: number): R;
}

declare module "vitest" {
	interface Assertion<T = any> extends CustomMatchers<T> {}
	interface AsymmetricMatchersContaining extends CustomMatchers {}
}

expect.extend({
	toConformToDAG(received: UinaTestHarness | readonly any[]) {
		try {
			if (Array.isArray(received)) {
				assertDAGInvariants(received);
			} else if (received && "host" in received && received.host?.session) {
				const nodes = received.host.session.list({ scope: "all" }).nodes;
				assertDAGInvariants(nodes);
			} else {
				throw new Error("传入对象既不是数组也不是 UinaTestHarness");
			}
			return {
				pass: true,
				message: () => "预期 DAG 不符合因果规则，但实际上通过了校验",
			};
		} catch (error) {
			return {
				pass: false,
				message: () => `DAG 因果规则被破坏: ${String(error)}`,
			};
		}
	},

	toHaveNoLeakedResources(received: UinaTestHarness) {
		try {
			assertNoResourceLeaks(received);
			return {
				pass: true,
				message: () => "预期存在未清理的资源，但系统已完全收敛",
			};
		} catch (error) {
			return {
				pass: false,
				message: () => String(error),
			};
		}
	},

	toHaveTurnCompleted(received: UinaTestHarness, turnNumber: number) {
		const endEvent = received.events.events.find(
			(e) => e.type === "turn_end" && (e as any).turnNumber === turnNumber,
		);
		const pass = Boolean(endEvent);
		return {
			pass,
			message: () =>
				pass
					? `预期回合 ${turnNumber} 未完成，但收到了 turn_end 事件`
					: `预期回合 ${turnNumber} 应该完成，但未找到对应的 turn_end 事件`,
		};
	},
});
