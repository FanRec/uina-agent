import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { MpvPlayer, type MpvTransport } from "../.uina/worlds/netease-jukebox/player.js";
import { PlaybackSession } from "../.uina/worlds/netease-jukebox/playback-session.js";

class FakeProcess extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly commands: Array<{ command: unknown[]; request_id: number }> = [];
  hold: (command: unknown[]) => boolean = () => false;
  setEncoding(): this { return this; }
  write(payload: string, _encoding: string, done: (error?: Error) => void): boolean {
    const request = JSON.parse(payload) as { command: unknown[]; request_id: number };
    this.commands.push(request);
    done();
    if (!this.hold(request.command)) {
      queueMicrotask(() => this.message({ request_id: request.request_id, error: "success" }));
    }
    return true;
  }
  message(value: unknown): void { this.emit("data", `${JSON.stringify(value)}\n`); }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}

function fakeTransport() {
  const child = new FakeProcess();
  const socket = new FakeSocket();
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const connect = vi.fn(async () => socket as unknown as Socket);
  const transport: MpvTransport = { spawn, connect };
  return { child, socket, spawn, connect, transport };
}

describe("MpvPlayer lifecycle with injected transport", () => {
  it("starts once for concurrent loads and lets the newer load win", async () => {
    const fake = fakeTransport();
    let finishConnect: ((socket: Socket) => void) | undefined;
    fake.connect.mockImplementation(() => new Promise<Socket>((resolve) => { finishConnect = resolve; }));
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const first = player.load("song://old", null);
    const firstRejected = expect(first).rejects.toThrow("取代");
    const second = player.load("song://new", null);
    finishConnect?.(fake.socket as unknown as Socket);
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[1] === "song://new")).toBe(true));
    fake.socket.message({ event: "start-file", playlist_entry_id: 2 });
    await firstRejected;
    await second;
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(player.status).toBe("playing");
    await player.close();
  });

  it("rejects loading promptly when stopped and ignores the late start event", async () => {
    const fake = fakeTransport();
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const loading = player.load("song://one", null);
    const rejected = expect(loading).rejects.toThrow("停止");
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    await player.stop();
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await rejected;
    expect(player.status).toBe("idle");
    await player.close();
  });

  it("uses a stop command before replacing a pending start", async () => {
    const fake = fakeTransport();
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const first = player.load("song://old", null);
    const firstRejected = expect(first).rejects.toThrow("取代");
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    const second = player.load("song://new", null);
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[0] === "stop")).toBe(true));
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[1] === "song://new")).toBe(true));
    expect(fake.socket.commands.map((item) => item.command[0])).toEqual(["loadfile", "stop", "loadfile"]);
    fake.socket.message({ event: "start-file", playlist_entry_id: 2 });
    await firstRejected;
    await second;
    await player.close();
  });

  it("lets PlaybackSession stop interrupt an in-flight load", async () => {
    const fake = fakeTransport();
    const session = new PlaybackSession(new MpvPlayer("fake-mpv", fake.transport));
    const loading = session.load("song://one", { id: "1", name: "一", artists: [], durationMs: null });
    const rejected = expect(loading).rejects.toThrow("停止");
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    await session.stop();
    await rejected;
    expect(session.snapshot()).toMatchObject({ status: "idle", currentSong: null });
    await session.close();
  });

  it("settles pending IPC on disconnect and clears the session's song", async () => {
    const fake = fakeTransport();
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const session = new PlaybackSession(player);
    const song = { id: "1", name: "测试曲", artists: ["歌手"], durationMs: null };
    const loading = session.load("song://one", song);
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await loading;
    fake.socket.hold = (command) => command[0] === "set_property" && command[1] === "pause";
    const pausing = session.pause();
    const rejected = expect(pausing).rejects.toThrow("断开");
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[2] === true)).toBe(true));
    fake.socket.destroy();
    await rejected;
    expect(session.snapshot()).toMatchObject({ status: "idle", currentSong: null, lastError: "mpv IPC 已断开" });
    await session.close();
  });

  it("ignores an old end event and reports an active-file error", async () => {
    const fake = fakeTransport();
    const session = new PlaybackSession(new MpvPlayer("fake-mpv", fake.transport));
    const first = session.load("song://one", { id: "1", name: "一", artists: [], durationMs: null });
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await first;

    const second = session.load("song://two", { id: "2", name: "二", artists: [], durationMs: null });
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[1] === "song://two")).toBe(true));
    fake.socket.message({ event: "start-file", playlist_entry_id: 2 });
    await second;
    fake.socket.message({ event: "end-file", reason: "eof", playlist_entry_id: 1 });
    expect(session.snapshot()).toMatchObject({ status: "playing", currentSong: { id: "2" } });

    fake.socket.message({ event: "end-file", reason: "error", playlist_entry_id: 2 });
    expect(session.snapshot()).toMatchObject({ status: "idle", currentSong: null, lastError: "mpv 播放文件失败" });
    await session.close();
  });

  it("accepts an eof event when mpv omits playlist_entry_id", async () => {
    const fake = fakeTransport();
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const session = new PlaybackSession(player);
    const loading = session.load("song://one", { id: "1", name: "一", artists: [], durationMs: null });
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await loading;
    fake.socket.message({ event: "end-file", reason: "eof" });
    expect(session.snapshot()).toMatchObject({ status: "idle", currentSong: null });
    await session.close();
  });

  it("does not report a rejected volume command as successful", async () => {
    const fake = fakeTransport();
    fake.socket.hold = (command) => command[0] === "set_property" && command[1] === "volume";
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const loading = player.load("song://one", null);
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await loading;
    const changing = player.setVolume(20);
    const rejected = expect(changing).rejects.toThrow("denied");
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[1] === "volume")).toBe(true));
    const request = fake.socket.commands.find((item) => item.command[1] === "volume")!;
    fake.socket.message({ request_id: request.request_id, error: "denied" });
    await rejected;
    expect(player.volume).toBe(80);
    await player.close();
  });

  it("retains the active entry when mpv rejects stop", async () => {
    const fake = fakeTransport();
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const loading = player.load("song://one", null);
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await loading;
    fake.socket.hold = (command) => command[0] === "stop";
    const stopping = player.stop();
    const rejected = expect(stopping).rejects.toThrow("denied");
    await vi.waitFor(() => expect(fake.socket.commands.some((item) => item.command[0] === "stop")).toBe(true));
    const request = fake.socket.commands.find((item) => item.command[0] === "stop")!;
    fake.socket.message({ request_id: request.request_id, error: "denied" });
    await rejected;
    expect(player.status).toBe("playing");
    fake.socket.message({ event: "end-file", reason: "eof", playlist_entry_id: 1 });
    expect(player.status).toBe("idle");
    await player.close();
  });

  it("reports no duration after a successful stop", async () => {
    const fake = fakeTransport();
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const loading = player.load("song://one", 12_000);
    await vi.waitFor(() => expect(fake.socket.commands[0]?.command[0]).toBe("loadfile"));
    fake.socket.message({ event: "start-file", playlist_entry_id: 1 });
    await loading;
    await player.stop();

    expect(await player.progress()).toEqual({ positionMs: 0, durationMs: null });
    await player.close();
  });

  it("cleans up the child when IPC startup fails", async () => {
    const fake = fakeTransport();
    fake.connect.mockRejectedValue(new Error("connect failed"));
    const player = new MpvPlayer("fake-mpv", fake.transport);
    await expect(player.load("song://one", null)).rejects.toThrow("Failed to connect");
    expect(fake.child.killed).toBe(true);
    expect(player.status).toBe("idle");
  });

  it("cancels a connection attempt when closed during startup", async () => {
    const fake = fakeTransport();
    let finishConnect: ((socket: Socket) => void) | undefined;
    fake.connect.mockImplementation(() => new Promise<Socket>((resolve) => { finishConnect = resolve; }));
    const player = new MpvPlayer("fake-mpv", fake.transport);
    const loading = player.load("song://one", null);
    const rejected = expect(loading).rejects.toThrow("mpv 已关闭");
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(1));
    await player.close();
    await rejected;
    expect(fake.child.killed).toBe(true);
    finishConnect?.(fake.socket as unknown as Socket);
    await vi.waitFor(() => expect(fake.socket.destroyed).toBe(true));
  });
});
