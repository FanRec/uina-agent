import { spawn, type ChildProcess } from "node:child_process";
import {
	trackChildProcess,
	untrackChildProcess,
} from "../../../src/extensions/world-framework/child-process-registry.js";

/**
 * spawn 之后多久算"起来了"。
 * 库内最短音效 488ms，正常播放不可能在 150ms 内自然结束，
 * 所以窗口内退出只可能是启动失败。
 */
const STARTUP_WINDOW_MS = 150;
/** stop 等每个进程退出的上限。 */
const STOP_TIMEOUT_MS = 500;

export type PlayOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "player_exited"; readonly exitCode: number | null }
	| { readonly ok: false; readonly reason: "spawn_failed"; readonly detail: string };

export interface StopOutcome {
	readonly stopped: number;
	readonly stragglers: number;
}

export interface SoundPlayer {
	play(binary: string, filepath: string, volume: number): Promise<PlayOutcome>;
	stop(): Promise<StopOutcome>;
}

/**
 * 每次播放起一个独立 mpv 进程，即时返回。
 *
 * 结算只到"进程已存活"——本进程没有听觉通道，说"已播放"就是编造。
 * 唯一的真实状态是还活着的子进程集合，stop 靠它工作。
 */
export class MpvSoundPlayer implements SoundPlayer {
	private readonly live = new Set<ChildProcess>();

	async play(binary: string, filepath: string, volume: number): Promise<PlayOutcome> {
		const clamped = Math.max(0, Math.min(100, Math.round(volume)));
		let proc: ChildProcess;
		try {
			proc = spawn(binary, ["--no-video", "--no-terminal", `--volume=${clamped}`, filepath], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch (error) {
			return { ok: false, reason: "spawn_failed", detail: error instanceof Error ? error.message : String(error) };
		}

		const pid = proc.pid;
		if (typeof pid === "number") trackChildProcess(pid);
		this.live.add(proc);
		const release = (): void => {
			this.live.delete(proc);
			if (typeof pid === "number") untrackChildProcess(pid);
		};
		proc.once("exit", release);

		return await new Promise<PlayOutcome>((resolve) => {
			const timer = setTimeout(() => resolve({ ok: true }), STARTUP_WINDOW_MS);
			proc.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code === 0 ? { ok: true } : { ok: false, reason: "player_exited", exitCode: code });
			});
			// 拿到 error 说明进程根本没起来（路径不对、没有执行权限）。
			proc.once("error", (error) => {
				clearTimeout(timer);
				release();
				resolve({ ok: false, reason: "spawn_failed", detail: error.message });
			});
		});
	}

	async stop(): Promise<StopOutcome> {
		const active = [...this.live].filter((proc) => proc.exitCode === null && proc.signalCode === null);
		await Promise.all(active.map((proc) => this.killAndWait(proc)));
		const stragglers = active.filter((proc) => proc.exitCode === null && proc.signalCode === null).length;
		return { stopped: active.length - stragglers, stragglers };
	}

	private async killAndWait(proc: ChildProcess): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				proc.kill();
			} catch {
				clearTimeout(timer);
				resolve();
			}
		});
	}
}
