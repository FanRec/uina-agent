import { cp, mkdir, readdir, rm } from "node:fs/promises";
// 浏览器薄面构建收尾：静态资源拷贝 + 剪除传递类型文件产生的死 emit。
// 页面运行时 import 图 = presentation/** + web-client/**；tsc 因 type-only 引用
// 会把 host/session/core/agent 等一并拉进程序并 emit（node 侧代码，浏览器不可达），
// 这里按图剪掉，dist/web 只留活产物。
const live = new Set(["presentation", "web-client", "index.html", "style.css"]);
const root = new URL("../dist/web/", import.meta.url);
await mkdir(root, { recursive: true });
await cp(new URL("../src/web-client/static/", import.meta.url), root, { recursive: true });
for (const name of await readdir(root)) {
	if (!live.has(name)) await rm(new URL(`${name}/`, root), { recursive: true, force: true });
}
