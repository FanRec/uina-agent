/**
 * Driver 控制仲裁：Body 资格与受控独占操作（goto）的单槽互斥。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §5.1、§9.3；plan §6。
 * 同一时刻客户端控制至多属于一方：Body 资格（PlayerPort 持有期间）或
 * 受控独占 Operation（GotoDirector 运行期间）。违反即调度违约
 * （CONTROL_CONFLICT），不引入公开协调 token 或动态资源调度框架。
 * 单槽语义：claim/release 由唯一所有方调用（PlayerPort/GotoDirector 各管己槽），
 * 不做引用登记；重复 release 无害（幂等）。
 */

export class DriverControlArbiter {
	private bodyClaimed = false;
	private gotoClaimed = false;

	/** 取得 Body 资格槽；goto 独占期间拒绝。 */
	tryClaimBody(): boolean {
		if (this.gotoClaimed) return false;
		this.bodyClaimed = true;
		return true;
	}

	releaseBody(): void {
		this.bodyClaimed = false;
	}

	/** 取得独占 Operation 槽；Body 资格持有期间拒绝。 */
	tryClaimGoto(): boolean {
		if (this.bodyClaimed) return false;
		this.gotoClaimed = true;
		return true;
	}

	releaseGoto(): void {
		this.gotoClaimed = false;
	}

	isGotoActive(): boolean {
		return this.gotoClaimed;
	}
}
