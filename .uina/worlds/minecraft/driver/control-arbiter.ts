/**
 * Driver 控制闸门：一个执行域内唯一有效的身体控制资格。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §5.1、§9.3。
 * Body 资格（PlayerPort 持有期间）与受控独占 Operation（GotoDirector 运行期间）
 * 是同一个 Bot 上相互冲突的两个写端，因此共用**一个**有效资格，而不是两个布尔槽。
 * 违反即调度违约（CONTROL_CONFLICT），不引入公开协调 token 或资源调度框架。
 *
 * 资格是不可转移、不可复活的 permit：claim 返回本次授予的对象，release 只接受
 * 同一对象。旧会话迟到的 close 回调持有旧 permit，抹不掉新 owner 的资格
 * （§6.2 不变量 3 / C09），因此不会让 Pathfinder 与新的 Body 并行控制同一 Bot。
 * 连接换代由执行域退役重建整个 arbiter，旧 permit 随旧执行域一起失效。
 */

export interface ControlPermit {
	readonly id: number;
	readonly kind: "body" | "goto";
}

export class DriverControlArbiter {
	private active: ControlPermit | null = null;
	private nextId = 0;

	/** 取得唯一控制资格；已有任何资格时拒绝，由调用方转成 CONTROL_CONFLICT。 */
	claim(kind: ControlPermit["kind"]): ControlPermit | null {
		if (this.active != null) return null;
		const permit: ControlPermit = { id: ++this.nextId, kind };
		this.active = permit;
		return permit;
	}

	/** 只释放自己那次授予；迟到、重复或来自旧 owner 的 release 一律无害。 */
	release(permit: ControlPermit): void {
		if (this.active === permit) this.active = null;
	}
}
