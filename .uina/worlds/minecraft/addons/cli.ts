/**
 * Addon 运维 CLI（pnpm mc:addon -- <command>）。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §2.4。数据根解析顺序：
 * `--root <dir>` > `UINA_MC_DATA_DIR` > `<cwd>/.uina/world-data/minecraft`（存在时）。
 * 不在运行时里硬编码数据根：World 永远用宿主提供的 worldDataDir。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import {
	addonStatus,
	disableAddon,
	enableAddon,
	inspectAddon,
	installAddon,
	listInstalledAddons,
	removeAddon,
} from "./manage.js";

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
}

function dataRoot(argv: string[]): string {
	const explicit = flag(argv, "root") ?? process.env.UINA_MC_DATA_DIR;
	if (explicit) return resolve(explicit);
	const fallback = join(process.cwd(), ".uina", "world-data", "minecraft");
	if (existsSync(fallback)) return fallback;
	throw new Error("cannot resolve the Minecraft data root; pass --root <worldDataDir> or set UINA_MC_DATA_DIR");
}

function profileId(argv: string[]): string {
	const value = flag(argv, "profile");
	if (!value) throw new Error("this command needs --profile <64-hex profile id> (see `list` output)");
	return value;
}

function configValue(argv: string[]): JsonValue | undefined {
	const raw = flag(argv, "config");
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw) as JsonValue;
	} catch {
		throw new Error("--config must be valid JSON");
	}
}

function print(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
try {
	const root = dataRoot(rest);
	switch (command) {
		case "list": {
			const listed = await listInstalledAddons(root);
			print({
				root,
				addons: listed.addons.map((entry) => ({
					id: entry.addon.id,
					version: entry.addon.version,
					dir: entry.addon.dir,
					enabledIn: entry.enabledIn,
					serverRequirement: entry.addon.manifest.serverRequirement,
				})),
				problems: listed.problems,
			});
			break;
		}
		case "inspect": {
			const id = rest[0];
			if (!id) throw new Error("usage: inspect <addon id>");
			print(await inspectAddon(root, id));
			break;
		}
		case "install": {
			const source = rest[0];
			if (!source) throw new Error("usage: install <package directory>");
			const installed = await installAddon(root, resolve(source));
			print({
				installed: { id: installed.id, version: installed.version, dir: installed.dir, entry: installed.entry },
			});
			break;
		}
		case "enable": {
			const id = rest[0];
			if (!id) throw new Error("usage: enable <addon id> --profile <id> [--config <json>]");
			await enableAddon({ root, profileId: profileId(rest), id, config: configValue(rest) });
			print({ enabled: id, profile: profileId(rest) });
			break;
		}
		case "disable": {
			const id = rest[0];
			if (!id) throw new Error("usage: disable <addon id> --profile <id>");
			await disableAddon({ root, profileId: profileId(rest), id });
			print({ disabled: id, profile: profileId(rest) });
			break;
		}
		case "remove": {
			const id = rest[0];
			if (!id) throw new Error("usage: remove <addon id>");
			await removeAddon(root, id);
			print({ removed: id });
			break;
		}
		case "status": {
			print(await addonStatus(root, flag(rest, "profile")));
			break;
		}
		default:
			console.error(
				[
					"usage: mc:addon -- <command> [args] [--root <worldDataDir>]",
					"  list",
					"  inspect <id>",
					"  install <package dir>",
					"  enable <id> --profile <profileId> [--config <json>]",
					"  disable <id> --profile <profileId>",
					"  remove <id>",
					"  status [--profile <profileId>]",
				].join("\n"),
			);
			process.exitCode = 2;
	}
} catch (error) {
	console.error((error as Error).message ?? String(error));
	process.exitCode = 1;
}
