/**
 * 事件总线：一切事件的单一通道。
 * 主体与外部（输入通道、后台任务）之间只通过 emit / on 通信，
 * 不直接互相持有引用——这是扩展新通道的边界所在。
 *
 * 注意：bus 只做同步派发，不做排队；"输出期间输入排队"由 Subject 负责。
 */
import { EventEmitter } from "node:events";

export type BusEvent =
	| { type: "user_input"; text: string; from: string } // 外部一条输入（人/通道/感知）
	| { type: "job_done"; jobId: string; result: string } // 后台任务完成，可唤醒主体
	| { type: "turn_start"; id: number }
	| { type: "turn_end"; id: number };

export class Bus {
	private readonly ee = new EventEmitter();

	on(handler: (e: BusEvent) => void): void {
		this.ee.on("event", handler);
	}

	emit(e: BusEvent): void {
		this.ee.emit("event", e);
	}
}
