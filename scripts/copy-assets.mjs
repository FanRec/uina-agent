import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
const destination = new URL("../dist/src/ui/core/native/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../src/ui/core/native/", import.meta.url), destination, { recursive: true });
const mcNative = new URL("../dist/.uina/worlds/minecraft/executor/platform/native/", import.meta.url);
await mkdir(mcNative, { recursive: true });
await cp(
	new URL("../.uina/worlds/minecraft/executor/platform/native/win32-x64.node", import.meta.url),
	new URL("win32-x64.node", mcNative),
);

const mcRoot = new URL("../dist/.uina/worlds/minecraft/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../.uina/worlds/minecraft/package.json", import.meta.url), "utf8"));
manifest.uina.entry = "worlddef/index.js";
await writeFile(new URL("package.json", mcRoot), JSON.stringify(manifest, null, 2) + "\n");
await cp(
	new URL("../.uina/worlds/minecraft/config.example.json", import.meta.url),
	new URL("config.example.json", mcRoot),
);
