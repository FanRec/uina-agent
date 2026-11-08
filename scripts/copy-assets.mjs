import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

// 官方静态教学资源：ENV 常驻正文、按需 Guide、参考 Program。
// 只复制声明的资源文件，不把 .ts 源码或开发目录绝对路径带进 dist。
const worlddefDst = new URL("worlddef/", mcRoot);
await mkdir(worlddefDst, { recursive: true });
await cp(
	new URL("../.uina/worlds/minecraft/worlddef/ENV_PROMPT.md", import.meta.url),
	new URL("ENV_PROMPT.md", worlddefDst),
);

const guideSrc = new URL("../.uina/worlds/minecraft/companion/guides/", import.meta.url);
const guideDst = new URL("companion/guides/", mcRoot);
await mkdir(guideDst, { recursive: true });
for (const file of (await readdir(guideSrc)).filter((name) => name.endsWith(".md")))
	await cp(new URL(file, guideSrc), new URL(file, guideDst));

const exampleSrc = new URL("../.uina/worlds/minecraft/examples/", import.meta.url);
const exampleDst = new URL("examples/", mcRoot);
await mkdir(exampleDst, { recursive: true });
for (const file of (await readdir(exampleSrc)).filter((name) => name.endsWith(".js")))
	await cp(new URL(file, exampleSrc), new URL(file, exampleDst));
