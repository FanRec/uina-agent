/** 临时脚本：解析 --cpu-prof 输出，按自采样时间聚合热点函数（跑完即删）。 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("用法: node scripts/parse-cpuprofile.mjs <profile.cpuprofile> [topN]");
	process.exit(1);
}
const topN = Number(process.argv[3] ?? 30);
const profile = JSON.parse(readFileSync(file, "utf8"));

/** 节点 id → { functionName, url, lineNumber, parent } */
const nodes = new Map();
for (const n of profile.nodes) {
	nodes.set(n.id, {
		fn: n.callFrame.functionName || "(anonymous)",
		url: (n.callFrame.url ?? "").replace(/^file:\/\//, "").replace(/^.*[\\/](src[\\/].*)$/, "$1"),
		line: n.callFrame.lineNumber + 1,
		parent: n.parent,
	});
}

/** 自采样时间（μs）聚合到节点自身；同时按 (fn@url) 聚合。 */
const selfById = new Map();
for (const n of profile.nodes) selfById.set(n.id, 0);
const deltas = profile.deltas ?? [];
// samples[i] 对应 timeDeltas[i]；V8 格式：samples + timeDeltas
const samples = profile.samples ?? [];
const timeDeltas = profile.timeDeltas ?? [];
let total = 0;
for (let i = 0; i < samples.length; i += 1) {
	const id = samples[i];
	const dt = Math.max(0, timeDeltas[i] ?? 0);
	selfById.set(id, (selfById.get(id) ?? 0) + dt);
	total += dt;
}

/** 自时间（自身帧）与总时间（含子调用）分开聚合。 */
const selfAgg = new Map();
const totalAgg = new Map();
// total time: 自底向上累加（遍历每个样本节点链）
const parentById = new Map();
for (const n of profile.nodes) parentById.set(n.id, n.parent);
const chainTotal = new Map();
for (let i = 0; i < samples.length; i += 1) {
	const dt = Math.max(0, timeDeltas[i] ?? 0);
	let id = samples[i];
	const seen = new Set();
	while (id !== undefined && id !== 0 && !seen.has(id)) {
		seen.add(id);
		chainTotal.set(id, (chainTotal.get(id) ?? 0) + dt);
		id = parentById.get(id);
	}
}
const keyOf = (n) => `${n.fn} @ ${n.url}:${n.line}`;
for (const [id, us] of selfById) {
	const n = nodes.get(id);
	if (!n || us === 0) continue;
	const k = keyOf(n);
	selfAgg.set(k, (selfAgg.get(k) ?? 0) + us);
}
for (const [id, us] of chainTotal) {
	const n = nodes.get(id);
	if (!n || us === 0) continue;
	const k = keyOf(n);
	totalAgg.set(k, (totalAgg.get(k) ?? 0) + us);
}
const fmt = (us) => `${(us / 1000).toFixed(0)}ms`;
console.log(`total sampled: ${(total / 1000 / 1000).toFixed(2)}s  samples=${samples.length}`);
console.log("\n── 自身时间 TOP ──");
[...selfAgg.entries()]
	.sort((a, b) => b[1] - a[1])
	.slice(0, topN)
	.forEach(([k, us]) => console.log(`${fmt(us).padStart(8)}  ${((us / total) * 100).toFixed(1)}%  ${k}`));
console.log("\n── 总时间（含子调用） TOP ──");
[...totalAgg.entries()]
	.sort((a, b) => b[1] - a[1])
	.slice(0, topN)
	.forEach(([k, us]) => console.log(`${fmt(us).padStart(8)}  ${((us / total) * 100).toFixed(1)}%  ${k}`));
