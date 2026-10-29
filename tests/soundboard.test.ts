import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterSounds, matchSounds, scanSounds } from "../.uina/worlds/soundboard/catalog.js";
import { createSoundboardWorld } from "../.uina/worlds/soundboard/index.js";
import {
	MpvSoundPlayer,
	type PlayOutcome,
	type SoundPlayer,
	type StopOutcome,
} from "../.uina/worlds/soundboard/player.js";
import type { SoundOverride } from "../.uina/worlds/soundboard/types.js";
import { resolveMpvPath } from "../src/extensions/world-framework/mpv-path.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";

/** 存在的可执行文件即可，假播放器不会真跑它。 */
const FAKE_BINARY = process.execPath;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	vi.resetModules();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const SOUND_FILES = [
	"moo-牛哞哞的叫声.wav",
	"metal_pipe-钢管落地音效.wav",
	"startup_windows_xp-Windows XP 开机音效.wav",
	"shutdown_windows_xp-Windows XP 关机音效.wav",
	"nodash.wav",
	"readme.txt",
];

async function makeSoundsDir(files: readonly string[] = SOUND_FILES): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "uina-soundboard-"));
	temporaryDirectories.push(dir);
	for (const file of files) await writeFile(join(dir, file), "");
	return dir;
}

interface FakePlayer {
	readonly player: SoundPlayer;
	readonly calls: Array<{ binary: string; filepath: string; volume: number }>;
	readonly stopResults: StopOutcome[];
}

function fakePlayer(outcome: PlayOutcome = { ok: true }, stopResult?: StopOutcome): FakePlayer {
	const calls: Array<{ binary: string; filepath: string; volume: number }> = [];
	const stopResults: StopOutcome[] = stopResult ? [stopResult] : [];
	return {
		calls,
		stopResults,
		player: {
			async play(binary, filepath, volume) {
				calls.push({ binary, filepath, volume });
				return outcome;
			},
			async stop() {
				return stopResults.shift() ?? { stopped: 0, stragglers: 0 };
			},
		},
	};
}

function worldWith(soundsDir: string, player: SoundPlayer, overrides?: Record<string, SoundOverride>): WorldDef {
	return createSoundboardWorld({
		config: { soundsDir, mpvPath: FAKE_BINARY, soundOverrides: overrides },
		player,
	});
}

function runAction(world: WorldDef, name: string, args: Record<string, unknown> = {}) {
	return world.actions[name]!.run(args, {
		operationIdentity: `world:soundboard/${name}`,
		signal: new AbortController().signal,
	});
}

describe("soundboard 文件名就是元数据", () => {
	it("按第一个 - 切分 id 与名称，忽略非音频文件和子目录", async () => {
		const dir = await makeSoundsDir();
		const sounds = await scanSounds(dir);

		expect(sounds.map((sound) => sound.id)).toEqual([
			"metal_pipe",
			"moo",
			"nodash",
			"shutdown_windows_xp",
			"startup_windows_xp",
		]);
		expect(sounds.find((sound) => sound.id === "moo")?.name).toBe("牛哞哞的叫声");
		expect(sounds.find((sound) => sound.id === "nodash")?.name).toBe("nodash");
		expect(await scanSounds(join(dir, "missing"))).toEqual([]);
	});
});

describe("soundboard 四级匹配不猜", () => {
	it("精确 id、精确名称、唯一子串、歧义、无匹配", async () => {
		const sounds = await scanSounds(await makeSoundsDir());

		expect(matchSounds(sounds, "MOO")).toMatchObject({ type: "match", sound: { id: "moo" } });
		expect(matchSounds(sounds, "钢管落地音效")).toMatchObject({ type: "match", sound: { id: "metal_pipe" } });
		expect(matchSounds(sounds, "牛哞")).toMatchObject({ type: "match", sound: { id: "moo" } });
		expect(matchSounds(sounds, "windows")).toMatchObject({ type: "ambiguous" });
		expect(matchSounds(sounds, "nothing-here")).toEqual({ type: "none" });
		expect(matchSounds(sounds, "  ")).toEqual({ type: "none" });
	});

	it("别名来自 config 覆盖，且能被精确命中", async () => {
		const sounds = await scanSounds(await makeSoundsDir(), { metal_pipe: { aliases: ["很吵"] } });
		expect(matchSounds(sounds, "很吵")).toMatchObject({ type: "match", sound: { id: "metal_pipe" } });
		expect(filterSounds(sounds, "牛")).toHaveLength(1);
		expect(filterSounds(sounds, "")).toHaveLength(sounds.length);
	});
});

describe("soundboard play", () => {
	it("成功只陈述到进程已存活，并回显 id", async () => {
		const fake = fakePlayer();
		const dir = await makeSoundsDir();
		const result = await runAction(worldWith(dir, fake.player), "play", { sound: "moo" });

		expect(result.status).toBe("succeeded");
		expect(result.result).toBe("播放中: 牛哞哞的叫声 [ID: moo] [effect=accepted]");
		expect(fake.calls).toEqual([{ binary: FAKE_BINARY, filepath: join(dir, "moo-牛哞哞的叫声.wav"), volume: 80 }]);
	});

	it("显式音量回显、与默认值相同则不回显", async () => {
		const explicitDefault = fakePlayer();
		const quiet = fakePlayer();
		const dir = await makeSoundsDir();

		const same = await runAction(worldWith(dir, explicitDefault.player), "play", { sound: "moo", volume: 80 });
		const quietResult = await runAction(worldWith(dir, quiet.player), "play", { sound: "moo", volume: 50 });

		expect(same.result).toBe("播放中: 牛哞哞的叫声 [ID: moo] [effect=accepted]");
		expect(quietResult.result).toBe("播放中: 牛哞哞的叫声 [ID: moo]，音量 50 [effect=accepted]");
		expect(quiet.calls[0]?.volume).toBe(50);
	});

	it("单文件音量偏移叠在入参之上", async () => {
		const fake = fakePlayer();
		const dir = await makeSoundsDir();
		const world = worldWith(dir, fake.player, { metal_pipe: { volumeOffset: -30 } });

		const result = await runAction(world, "play", { sound: "metal_pipe" });

		expect(fake.calls[0]?.volume).toBe(50);
		expect(result.result).toBe("播放中: 钢管落地音效 [ID: metal_pipe]，音量 50 [effect=accepted]");
	});

	it("偏移抵消了她的入参时，仍然回显实际生效的音量", async () => {
		const fake = fakePlayer();
		const dir = await makeSoundsDir();
		const world = worldWith(dir, fake.player, { moo: { volumeOffset: 30 } });

		const result = await runAction(world, "play", { sound: "moo", volume: 50 });

		expect(fake.calls[0]?.volume).toBe(80);
		expect(result.result).toBe("播放中: 牛哞哞的叫声 [ID: moo]，音量 80 [effect=accepted]");
	});

	it("目录为空时不说'可放的：'后面什么都没有", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-soundboard-empty-"));
		temporaryDirectories.push(dir);
		const result = await runAction(worldWith(dir, fakePlayer().player), "play", { sound: "moo" });

		expect(result.status).toBe("failed");
		expect(result.result).toBe(`音效目录为空或不存在: ${dir} [reason=no_sounds]`);
	});

	it("未命中时直接把全部 id 交回去", async () => {
		const fake = fakePlayer();
		const result = await runAction(worldWith(await makeSoundsDir(), fake.player), "play", { sound: "没有这个" });

		expect(result.status).toBe("failed");
		expect(result.result).toContain('没有与 "没有这个" 匹配的音效');
		expect(result.result).toContain("moo");
		expect(result.result).toContain("[reason=sound_not_found]");
		expect(fake.calls).toEqual([]);
	});

	it("歧义时列出候选并要求用完整 id", async () => {
		const fake = fakePlayer();
		const result = await runAction(worldWith(await makeSoundsDir(), fake.player), "play", { sound: "windows" });

		expect(result.status).toBe("failed");
		expect(result.result).toContain("匹配到 2 个音效");
		expect(result.result).toContain("[ID: startup_windows_xp]");
		expect(result.result).toContain("[ID: shutdown_windows_xp]");
		expect(result.result).toContain("用完整的 ID 再调一次");
		expect(fake.calls).toEqual([]);
	});

	it("播放器立即退出时如实报告，不说播放了", async () => {
		const fake = fakePlayer({ ok: false, reason: "player_exited", exitCode: 1 });
		const result = await runAction(worldWith(await makeSoundsDir(), fake.player), "play", { sound: "moo" });

		expect(result.status).toBe("failed");
		expect(result.result).toContain("播放器立即退出（exit=1）");
		expect(result.result).toContain("[reason=player_exited]");
	});
});

describe("soundboard list", () => {
	it("全量与过滤，且不提播放器健康", async () => {
		const dir = await makeSoundsDir();
		const world = worldWith(dir, fakePlayer().player);

		const all = await runAction(world, "list");
		expect(all.status).toBe("succeeded");
		expect(all.result).toContain("音效列表（共 5 个）");
		expect(all.result).toContain(" 1. [ID: metal_pipe] 钢管落地音效");

		const filtered = await runAction(world, "list", { query: "windows" });
		expect(filtered.result).toContain("音效列表（共 2 个）");
		expect(filtered.result).not.toContain("moo");
	});

	it("空目录明确失败", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-soundboard-empty-"));
		temporaryDirectories.push(dir);
		const result = await runAction(worldWith(dir, fakePlayer().player), "list");

		expect(result.status).toBe("failed");
		expect(result.result).toContain("音效目录为空或不存在");
		expect(result.result).toContain("[reason=no_sounds]");
	});
});

describe("soundboard stop", () => {
	it("停掉时报告数量并以 applied 结算", async () => {
		const fake = fakePlayer({ ok: true }, { stopped: 2, stragglers: 0 });
		const result = await runAction(worldWith(await makeSoundsDir(), fake.player), "stop");

		expect(result.status).toBe("succeeded");
		expect(result.result).toBe("已停止 2 个音效。 [effect=applied]");
	});

	it("没在播时说实话", async () => {
		const result = await runAction(worldWith(await makeSoundsDir(), fakePlayer().player), "stop");
		expect(result.result).toBe("没有正在播放的音效。 [effect=applied]");
	});

	it("有进程未退出时以 unknown 结算", async () => {
		const fake = fakePlayer({ ok: true }, { stopped: 1, stragglers: 1 });
		const result = await runAction(worldWith(await makeSoundsDir(), fake.player), "stop");

		expect(result.status).toBe("unknown");
		expect(result.result).toBe("已停止 1 个，1 个未确认退出。");
	});
});

describe("soundboard 播放器不可用", () => {
	it("找不到 mpv 时明确失败，并指向 config.mpvPath", async () => {
		vi.resetModules();
		vi.doMock("../src/extensions/world-framework/mpv-path.js", () => ({ resolveMpvPath: () => null }));
		const fresh = (await import(
			"../.uina/worlds/soundboard/index.js"
		)) as typeof import("../.uina/worlds/soundboard/index.js");
		const fake = fakePlayer();

		const result = await runAction(
			fresh.createSoundboardWorld({ config: { soundsDir: await makeSoundsDir() }, player: fake.player }),
			"play",
			{ sound: "moo" },
		);

		expect(result.status).toBe("failed");
		expect(result.result).toContain("没有找到 mpv");
		expect(result.result).toContain("config.json");
		expect(result.result).toContain("[reason=player_unavailable]");
		expect(fake.calls).toEqual([]);
		vi.doUnmock("../src/extensions/world-framework/mpv-path.js");
	});

	it("死路径不抛出，而是 spawn_failed", async () => {
		const outcome = await new MpvSoundPlayer().play("C:\\definitely-missing\\mpv.exe", join(tmpdir(), "none.wav"), 80);
		expect(outcome.ok).toBe(false);
		expect(outcome).toMatchObject({ reason: "spawn_failed" });
	});

	const realMpv = resolveMpvPath();
	it.skipIf(!realMpv)("真实 mpv 播放一声 moo 并能立刻停掉", async () => {
		const world = createSoundboardWorld();
		const played = await runAction(world, "play", { sound: "moo" });
		expect(played.status).toBe("succeeded");
		expect(played.result).toContain("[effect=accepted]");
		await runAction(world, "stop");
	});
});
