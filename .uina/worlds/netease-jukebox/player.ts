import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { PlaybackStatus } from "./types.js";

export interface PlayerProgress {
  readonly positionMs: number;
  readonly durationMs: number | null;
}

export interface MpvIpcMessage {
  readonly request_id?: number;
  readonly error?: string;
  readonly data?: unknown;
  readonly event?: string;
  readonly reason?: string;
  readonly playlist_entry_id?: number;
}

export interface MpvTransport {
  spawn(path: string, args: readonly string[]): ChildProcess;
  connect(path: string): Promise<Socket>;
}

const nodeMpvTransport: MpvTransport = {
  spawn: (path, args) => spawn(path, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }),
  connect: (path) => new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  }),
};

/** Protocol seam: malformed IPC is an observable protocol failure, never a fake event. */
export function parseMpvLine(line: string): MpvIpcMessage | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === "object" ? value as MpvIpcMessage : null;
  } catch {
    return null;
  }
}

export interface MusicPlayer {
  readonly status: PlaybackStatus;
  readonly volume: number;
  readonly isSimulated: boolean;
  readonly availability: "real" | "simulation" | "unavailable";
  load(url: string, durationMs: number | null, songId?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setVolume(volumePercent: number): Promise<void>;
  progress(): Promise<PlayerProgress>;
  seek(positionMs: number): Promise<void>;
  close(): Promise<void>;
  on(event: "ended" | "error", listener: (info?: { reason: "eof" | "stop" | "error"; trackId: number } | Error) => void): this;
}

export function resolveMpvPath(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) {
    return customPath;
  }
  if (process.env.MPV_PATH && existsSync(process.env.MPV_PATH)) {
    return process.env.MPV_PATH;
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\MPV Player\\mpv.com",
      "C:\\Program Files\\MPV Player\\mpv.exe",
      "C:\\Program Files\\mpv\\mpv.com",
      "C:\\Program Files\\mpv\\mpv.exe",
      "C:\\Program Files (x86)\\mpv\\mpv.com",
      "C:\\Program Files (x86)\\mpv\\mpv.exe",
      "C:\\tools\\mpv\\mpv.com",
      "C:\\tools\\mpv\\mpv.exe",
      "E:\\Uina_Core\\tools\\mpv.exe",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        return c;
      }
    }
  }
  return null;
}

export class SimulatedMusicPlayer extends EventEmitter implements MusicPlayer {
  readonly isSimulated = true;
  readonly availability = "simulation" as const;
  private _status: PlaybackStatus = "idle";
  private _volume = 80;
  private startedAt = 0;
  private pausedAtMs = 0;
  private durationMs: number | null = null;
  private endTimer: NodeJS.Timeout | null = null;

  get status(): PlaybackStatus {
    return this._status;
  }

  get volume(): number {
    return this._volume;
  }

  async load(_url: string, durationMs: number | null): Promise<void> {
    this.clearTimer();
    this._status = "playing";
    this.startedAt = Date.now();
    this.pausedAtMs = 0;
    this.durationMs = durationMs;
    this.scheduleEnd();
  }

  async pause(): Promise<void> {
    if (this._status !== "playing") {
      return;
    }
    this.pausedAtMs = (await this.progress()).positionMs;
    this._status = "paused";
    this.clearTimer();
  }

  async resume(): Promise<void> {
    if (this._status !== "paused") {
      return;
    }
    this._status = "playing";
    this.startedAt = Date.now() - this.pausedAtMs;
    this.scheduleEnd();
  }

  async stop(): Promise<void> {
    this._status = "idle";
    this.pausedAtMs = 0;
    this.durationMs = null;
    this.clearTimer();
  }

  async setVolume(volumePercent: number): Promise<void> {
    this._volume = Math.min(100, Math.max(0, Math.round(volumePercent)));
  }

  async seek(positionMs: number): Promise<void> {
    const clamped = this.durationMs === null
      ? Math.max(0, positionMs)
      : Math.min(Math.max(0, positionMs), this.durationMs);
    // pausedAtMs 同时是 resume 偏移与 scheduleEnd 的剩余时长基准，seek 时两处都要对齐。
    this.pausedAtMs = clamped;
    if (this._status === "playing") {
      this.startedAt = Date.now() - clamped;
      this.scheduleEnd();
    }
  }

  async progress(): Promise<PlayerProgress> {
    if (this._status === "playing") {
      const positionMs = Math.max(0, Date.now() - this.startedAt);
      return {
        positionMs: this.durationMs === null ? positionMs : Math.min(positionMs, this.durationMs),
        durationMs: this.durationMs,
      };
    }
    return {
      positionMs: this.pausedAtMs,
      durationMs: this.durationMs,
    };
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private scheduleEnd(): void {
    this.clearTimer();
    if (this.durationMs === null) {
      return;
    }
    const remaining = Math.max(0, this.durationMs - this.pausedAtMs);
    this.endTimer = setTimeout(() => {
      if (this._status === "playing") {
        this._status = "idle";
        this.emit("ended");
      }
    }, remaining);
  }

  private clearTimer(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }
}

export class UnavailableMusicPlayer extends EventEmitter implements MusicPlayer {
  readonly isSimulated = false;
  readonly availability = "unavailable" as const;
  private _volume = 80;
  get status(): PlaybackStatus { return "idle"; }
  get volume(): number { return this._volume; }
  async load(): Promise<void> { throw new Error("未找到 mpv 播放器"); }
  async pause(): Promise<void> { throw new Error("未找到 mpv 播放器"); }
  async resume(): Promise<void> { throw new Error("未找到 mpv 播放器"); }
  async stop(): Promise<void> {}
  async setVolume(volume: number): Promise<void> { this._volume = Math.min(100, Math.max(0, Math.round(volume))); }
  async progress(): Promise<PlayerProgress> { return { positionMs: 0, durationMs: null }; }
  async seek(): Promise<void> { throw new Error("未找到 mpv 播放器"); }
  async close(): Promise<void> {}
}

export class MpvPlayer extends EventEmitter implements MusicPlayer {
  readonly isSimulated = false;
  readonly availability = "real" as const;
  private _status: PlaybackStatus = "idle";
  private _volume = 80;
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private ipcPath: string | null = null;
  private requestId = 0;
  private trackId = 0;
  private activeEntryId: number | null = null;
  private startWaiter: { generation: number; resolve: (entryId: number) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readBuffer = "";
  private durationHintMs: number | null = null;
  private starting: Promise<void> | null = null;
  private startupAbort: AbortController | null = null;
  private startupId = 0;
  private closing = false;

  constructor(private readonly mpvPath = "mpv", private readonly transport: MpvTransport = nodeMpvTransport) {
    super();
  }

  get status(): PlaybackStatus {
    return this._status;
  }

  get volume(): number {
    return this._volume;
  }

  async load(url: string, durationMs: number | null, _songId?: string): Promise<void> {
    const generation = ++this.trackId;
    const replacingPendingStart = this.startWaiter !== null;
    this.cancelStart(new Error("播放项已被新歌曲取代"));
    await this.ensureStarted();
    if (generation !== this.trackId) throw new Error("播放项已被新歌曲取代");
    if (replacingPendingStart) {
      await this.command(["stop"]);
      if (generation !== this.trackId) throw new Error("播放项已被新歌曲取代");
    }
    const started = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.startWaiter = null;
        reject(new Error("mpv 未报告 start-file 播放项"));
      }, 10_000);
      this.startWaiter = { generation, resolve, reject, timer };
    });
    let entryId: number;
    try {
      [, entryId] = await Promise.all([this.command(["loadfile", url, "replace"]), started]);
    } catch (error) {
      if (this.startWaiter?.generation === generation) this.cancelStart(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (generation !== this.trackId) throw new Error("播放项已被新歌曲取代");
    this.activeEntryId = entryId;
    await this.command(["set_property", "pause", false]);
    this.durationHintMs = durationMs;
    this._status = "playing";
  }

  async pause(): Promise<void> {
    if (!this.socket) throw new Error("mpv 未启动");
    await this.command(["set_property", "pause", true]);
    this._status = "paused";
  }

  async resume(): Promise<void> {
    if (!this.socket) throw new Error("mpv 未启动");
    await this.command(["set_property", "pause", false]);
    this._status = "playing";
  }

  async stop(): Promise<void> {
    this.trackId++;
    this.cancelStart(new Error("播放已停止"));
    if (!this.socket) {
      this.activeEntryId = null;
      this.durationHintMs = null;
      this._status = "idle";
      return;
    }
    await this.command(["stop"]);
    this.activeEntryId = null;
    this.durationHintMs = null;
    this._status = "idle";
  }

  async setVolume(volumePercent: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(volumePercent)));
    if (this.socket) {
      await this.command(["set_property", "volume", clamped]);
    }
    this._volume = clamped;
  }

  async seek(positionMs: number): Promise<void> {
    if (!this.socket) throw new Error("mpv 未启动");
    await this.command(["seek", positionMs / 1000, "absolute"]);
  }

  async progress(): Promise<PlayerProgress> {
    if (this._status === "idle") return { positionMs: 0, durationMs: null };
    if (!this.socket) {
      return { positionMs: 0, durationMs: this.durationHintMs };
    }
    const [timePos, duration] = await Promise.all([
      this.command(["get_property", "time-pos"]).catch(() => null),
      this.command(["get_property", "duration"]).catch(() => null),
    ]);
    const posSec = typeof timePos === "number" ? timePos : 0;
    const durSec = typeof duration === "number" ? duration : null;
    return {
      positionMs: Math.round(posSec * 1000),
      durationMs: durSec !== null ? Math.round(durSec * 1000) : this.durationHintMs,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.startupAbort?.abort(new Error("mpv 已关闭"));
    this.startupId++;
    this.trackId++;
    this.activeEntryId = null;
    this.cancelStart(new Error("mpv 已关闭"));
    if (this.socket) await this.command(["quit"]).catch(() => undefined);
    this.socket?.destroy();
    this.socket = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.rejectPending(new Error("mpv 已关闭"));
    this._status = "idle";
    await this.starting?.catch(() => undefined);
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.starting) return this.starting;
    const startupId = ++this.startupId;
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    this.starting = this.startInternal(startupId, startupAbort.signal);
    try {
      await this.starting;
    } finally {
      this.starting = null;
      if (this.startupAbort === startupAbort) this.startupAbort = null;
    }
  }

  private async startInternal(startupId: number, signal: AbortSignal): Promise<void> {
    this.closing = false;
    this.ipcPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\uina_mpv_${process.pid}_${Date.now()}`
        : join(tmpdir(), `uina_mpv_${process.pid}_${Date.now()}.sock`);

    const child = this.transport.spawn(this.mpvPath, [
        "--idle=yes",
        "--no-video",
        "--input-terminal=no",
        "--really-quiet",
        `--volume=${this._volume}`,
        `--input-ipc-server=${this.ipcPath}`,
      ]);
    this.process = child;

    child.once("exit", () => this.failConnection(child, new Error("mpv 进程已退出")));
    child.once("error", (error) => this.failConnection(child, error));

    try {
      const socket = await this.connectWithRetry(this.ipcPath, 30, 50, signal);
      if (startupId !== this.startupId || this.process !== child) {
        socket.destroy();
        throw new Error("mpv 启动已取消");
      }
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => this.handleData(String(chunk)));
      socket.on("error", (error) => this.failConnection(child, error));
      socket.on("close", () => this.failConnection(child, new Error("mpv IPC 已断开")));
    } catch (error) {
      this.failConnection(child, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async connectWithRetry(path: string, attempts: number, delayMs: number, signal: AbortSignal): Promise<Socket> {
    for (let i = 0; i < attempts; i++) {
      signal.throwIfAborted();
      try {
        const connecting = this.transport.connect(path);
        void connecting.then((socket) => { if (signal.aborted) socket.destroy(); }).catch(() => undefined);
        let onAbort: () => void = () => undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("mpv 启动已取消"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          return await Promise.race([connecting, aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } catch {
        signal.throwIfAborted();
        if (!this.process) break;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(`Failed to connect to mpv IPC at ${path}`);
  }

  private async command(command: readonly unknown[]): Promise<unknown> {
    if (!this.socket) {
      throw new Error("mpv IPC socket not available");
    }
    const requestId = ++this.requestId;
    const payload = JSON.stringify({ command, request_id: requestId }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("mpv IPC 请求超时"));
      }, 10_000);
      this.pending.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket?.write(payload, "utf8", (err) => {
        if (err) {
          this.pending.delete(requestId);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private rejectPending(error: Error): void {
    this.cancelStart(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private cancelStart(error: Error): void {
    if (!this.startWaiter) return;
    clearTimeout(this.startWaiter.timer);
    this.startWaiter.reject(error);
    this.startWaiter = null;
  }

  private failConnection(child: ChildProcess, error: Error): void {
    if (this.process !== child) return;
    this.socket?.destroy();
    this.socket = null;
    this.process = null;
    if (!child.killed) child.kill();
    this._status = "idle";
    this.activeEntryId = null;
    this.rejectPending(error);
    if (!this.closing && this.listenerCount("error") > 0) this.emit("error", error);
  }

  private handleData(chunk: string): void {
    this.readBuffer += chunk;
    let newline = this.readBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.readBuffer.slice(0, newline).trim();
      this.readBuffer = this.readBuffer.slice(newline + 1);
      if (line) {
          const msg = parseMpvLine(line);
          if (!msg) {
            this.emit("error", new Error("mpv IPC 返回非法 JSON"));
            newline = this.readBuffer.indexOf("\n");
            continue;
          }
          if (typeof msg.request_id === "number") {
            const p = this.pending.get(msg.request_id);
            if (p) {
              this.pending.delete(msg.request_id);
              if (msg.error === "success") {
                p.resolve(msg.data);
              } else {
                p.reject(new Error(msg.error ?? "mpv command failed"));
              }
            }
          } else if (msg.event === "start-file" && typeof msg.playlist_entry_id === "number") {
            this.activeEntryId = msg.playlist_entry_id;
            if (this.startWaiter) {
              const waiter = this.startWaiter;
              this.startWaiter = null;
              clearTimeout(waiter.timer);
              if (waiter.generation === this.trackId) waiter.resolve(msg.playlist_entry_id);
            }
          } else if (msg.event === "end-file" && (msg.playlist_entry_id === undefined || msg.playlist_entry_id === this.activeEntryId)) {
            this._status = "idle";
            this.activeEntryId = null;
            if (msg.reason === "error") {
              if (this.listenerCount("error") > 0) this.emit("error", new Error("mpv 播放文件失败"));
            } else {
              this.emit("ended", { reason: msg.reason === "eof" ? "eof" : "stop", trackId: this.trackId });
            }
          }
      }
      newline = this.readBuffer.indexOf("\n");
    }
  }
}
