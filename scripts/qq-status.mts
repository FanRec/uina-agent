// Pure local diagnostics. Lifecycle owns recovery and migration.
// qq-status.mts [worldDir] [--data-root <QQ world data root> | --profile-root <subject state root>]
import { join, resolve } from "node:path";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { loadQqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { qqStatusLines } from "../.uina/worlds/qq/src/reader.js";

const args = process.argv.slice(2);
let worldDir = join(process.cwd(), ".uina", "worlds", "qq");
let dataRoot: string | undefined;
let profileRoot: string | undefined;
let positional = false;
for (let index = 0; index < args.length; index++) {
	const arg = args[index]!;
	if (arg === "--data-root" || arg === "--profile-root") {
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
		if (arg === "--data-root") dataRoot = resolve(value);
		else profileRoot = resolve(value);
	} else if (arg.startsWith("--") || positional) throw new Error(`Unknown argument: ${arg}`);
	else {
		worldDir = resolve(arg);
		positional = true;
	}
}
if (dataRoot && profileRoot) throw new Error("Choose --data-root or --profile-root");
const loaded = loadQqWorldConfig(join(worldDir, "config.json"));
if (!loaded.ok) throw new Error(`[qq] 配置加载失败：${loaded.error}`);
const selfId = loaded.config.selfId;
const root =
	dataRoot ?? (profileRoot ? join(profileRoot, "world-data", "qq") : join(process.cwd(), ".uina", "world-data", "qq"));
const dataDir = join(root, "v2", selfId);
const journal = new FactsJournal({ dataDir, selfId });
const facts = journal.recover(true);
const control = new ControlStore({ dataDir, selfId });
control.load(true);
const ops = new OperationLog({ dataDir, selfId });
const operations = ops.recover(true);
console.log(
	`dataDir=${dataDir}；忽略未完成尾行=${facts.truncatedTailLines + operations.truncatedTailLines}；未修改文件`,
);
for (const line of qqStatusLines({ selfId, journal, control, ops })) console.log(line);
