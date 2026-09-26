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

export interface MusicPlayer {
  readonly status: PlaybackStatus;
  readonly volume: number;
  readonly isSimulated: boolean;
  load(url: string, durationMs: number | null): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setVolume(volumePercent: number): Promise<void>;
  progress(): Promise<PlayerProgress>;
  close(): Promise<void>;
  on(event: "ended" | "error", listener: (error?: Error) => void): this;
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
    this.clearTimer();
  }

  async setVolume(volumePercent: number): Promise<void> {
    this._volume = Math.min(100, Math.max(0, Math.round(volumePercent)));
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

export class MpvPlayer extends EventEmitter implements MusicPlayer {
  readonly isSimulated = false;
  private _status: PlaybackStatus = "idle";
  private _volume = 80;
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private ipcPath: string | null = null;
  private requestId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readBuffer = "";
  private durationHintMs: number | null = null;

  constructor(private readonly mpvPath = "mpv") {
    super();
  }

  get status(): PlaybackStatus {
    return this._status;
  }

  get volume(): number {
    return this._volume;
  }

  async load(url: string, durationMs: number | null): Promise<void> {
    await this.ensureStarted();
    this.durationHintMs = durationMs;
    await this.command(["loadfile", url, "replace"]);
    await this.command(["set_property", "pause", false]);
    this._status = "playing";
  }

  async pause(): Promise<void> {
    await this.command(["set_property", "pause", true]);
    this._status = "paused";
  }

  async resume(): Promise<void> {
    await this.command(["set_property", "pause", false]);
    this._status = "playing";
  }

  async stop(): Promise<void> {
    if (!this.socket) {
      this._status = "idle";
      return;
    }
    await this.command(["stop"]).catch(() => undefined);
    this._status = "idle";
  }

  async setVolume(volumePercent: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(volumePercent)));
    this._volume = clamped;
    if (this.socket) {
      await this.command(["set_property", "volume", clamped]).catch(() => undefined);
    }
  }

  async progress(): Promise<PlayerProgress> {
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
    await this.command(["quit"]).catch(() => undefined);
    this.socket?.destroy();
    this.socket = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this._status = "idle";
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.socket && !this.socket.destroyed) {
      return;
    }
    this.ipcPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\uina_mpv_${process.pid}_${Date.now()}`
        : join(tmpdir(), `uina_mpv_${process.pid}_${Date.now()}.sock`);

    this.process = spawn(
      this.mpvPath,
      [
        "--idle=yes",
        "--no-video",
        "--input-terminal=no",
        "--really-quiet",
        `--input-ipc-server=${this.ipcPath}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    this.process.once("exit", () => {
      this.socket?.destroy();
      this.socket = null;
      this.process = null;
      this._status = "idle";
    });

    this.socket = await this.connectWithRetry(this.ipcPath, 30, 50);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.handleData(String(chunk)));
    this.socket.on("error", (err) => this.emit("error", err));
  }

  private async connectWithRetry(path: string, attempts: number, delayMs: number): Promise<Socket> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const s = createConnection(path);
          s.once("connect", () => resolve(s));
          s.once("error", (err) => {
            s.destroy();
            reject(err);
          });
        });
      } catch {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(`Failed to connect to mpv IPC at ${path}`);
  }

  private async command(command: readonly unknown[]): Promise<unknown> {
    await this.ensureStarted();
    if (!this.socket) {
      throw new Error("mpv IPC socket not available");
    }
    const requestId = ++this.requestId;
    const payload = JSON.stringify({ command, request_id: requestId }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket?.write(payload, "utf8", (err) => {
        if (err) {
          this.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  private handleData(chunk: string): void {
    this.readBuffer += chunk;
    let newline = this.readBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.readBuffer.slice(0, newline).trim();
      this.readBuffer = this.readBuffer.slice(newline + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as {
            request_id?: number;
            error?: string;
            data?: unknown;
            event?: string;
          };
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
          } else if (msg.event === "end-file") {
            this._status = "idle";
            this.emit("ended");
          }
        } catch {
          // ignore parse error
        }
      }
      newline = this.readBuffer.indexOf("\n");
    }
  }
}
