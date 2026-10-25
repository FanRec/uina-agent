import { cp, mkdir } from "node:fs/promises";
const destination = new URL("../dist/src/ui/core/native/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../src/ui/core/native/", import.meta.url), destination, { recursive: true });
const mcNative = new URL("../dist/.uina/worlds/minecraft/executor/platform/native/", import.meta.url);
await mkdir(mcNative, { recursive: true });
await cp(
	new URL("../.uina/worlds/minecraft/executor/platform/native/win32-x64.node", import.meta.url),
	new URL("win32-x64.node", mcNative),
);
