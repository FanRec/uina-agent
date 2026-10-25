import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export async function buildMinecraftNative() {
	if (process.platform !== "win32" || process.arch !== "x64")
		throw new Error("Minecraft native ownership requires Windows x64");
	const compiler = process.env.MC_NATIVE_CXX ?? "g++";
	const headers =
		process.env.MC_NODE_HEADERS ??
		join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "node-gyp", "Cache", process.versions.node);
	const include = join(headers, "include", "node");
	const library = join(headers, "x64", "node.lib");
	for (const required of [join(include, "node_api.h"), library]) {
		if (!existsSync(required)) throw new Error(`Missing Minecraft native build prerequisite: ${required}`);
	}
	const root = new URL("../.uina/worlds/minecraft/executor/platform/native/", import.meta.url);
	await mkdir(root, { recursive: true });
	const output = fileURLToPath(new URL("win32-x64.node", root));
	await new Promise((resolve, reject) => {
		const child = spawn(
			compiler,
			[
				"-std=c++17",
				"-O2",
				"-shared",
				"-static",
				"-DNAPI_VERSION=8",
				"-I",
				include,
				fileURLToPath(new URL("windows-ownership.cc", root)),
				library,
				"-ladvapi32",
				"-o",
				output,
			],
			{ stdio: "inherit", windowsHide: true },
		);
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`Minecraft native compiler exited ${code}`)),
		);
	});
	return output;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	console.log(await buildMinecraftNative());
}
