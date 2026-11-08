/**
 * 构建 Uina example Paper 插件（真实服务端测试夹具）。
 *
 * 用服务器自带的 paper-api 与 libraries 作为 classpath，javac 21 编译，
 * 产出 `<dev-env>/uina-plugin/uina-example-plugin.jar` 并复制到 server/plugins/。
 * 不引入 Gradle/Maven：这是测试夹具，不是产品构建。
 *
 * 用法：node .uina/worlds/minecraft/dev-env/uina-plugin/build.mjs [--no-install]
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..", "server");
const libraries = join(serverDir, "libraries");
const outDir = join(here, "out");
const jarPath = join(here, "uina-example-plugin.jar");
const install = !process.argv.includes("--no-install");

if (!existsSync(libraries)) throw new Error(`server libraries not found at ${libraries}`);

function jarsUnder(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jarsUnder(path));
		else if (entry.name.endsWith(".jar")) out.push(path);
	}
	return out;
}

const classpath = jarsUnder(libraries)
	.map((path) => path.replace(/\\/g, "/"))
	.join(";");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const sources = [join(here, "src", "dev", "uina", "example", "UinaExamplePlugin.java")];
const argFile = join(here, "javac.args");
// javac 的 @argfile 会把反斜杠当转义：路径统一用正斜杠。
writeFileSync(
	argFile,
	[
		`-cp "${classpath}"`,
		`-d "${outDir.replace(/\\/g, "/")}"`,
		...sources.map((source) => `"${source.replace(/\\/g, "/")}"`),
	].join("\n"),
);
execFileSync("javac", [`@${argFile}`], { stdio: "inherit" });
cpSync(join(here, "src", "plugin.yml"), join(outDir, "plugin.yml"));
rmSync(jarPath, { force: true });
execFileSync("jar", ["--create", "--file", jarPath, "-C", outDir, "."], { stdio: "inherit" });
if (install) {
	const plugins = join(serverDir, "plugins");
	mkdirSync(plugins, { recursive: true });
	cpSync(jarPath, join(plugins, "uina-example-plugin.jar"));
	console.log(`installed ${jarPath} -> ${join(plugins, "uina-example-plugin.jar")}`);
}
console.log(`built ${jarPath}`);
