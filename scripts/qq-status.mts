// qq_status 诊断命令（设计 §4/§3：仅 CLI/内部自检，不注册为主体模型工具）。
// 只读装配：加载配置与本地存储（journal recover + control load，与 onStart 同路径），
// 打印消费位/基线/通知位/待处理/推送偏好与跳过审计；不连接平台，不产生副作用。
// 用法：pnpm tsx scripts/qq-status.mts [worldDir]（缺省 .uina/worlds/qq）

import { join } from "node:path";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { loadQqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { qqStatusLines } from "../.uina/worlds/qq/src/reader.js";

const worldDir = process.argv[2] ?? join(process.cwd(), ".uina", "worlds", "qq");
const loaded = loadQqWorldConfig(join(worldDir, "config.json"));
if (!loaded.ok) {
	console.error(`[qq] 配置加载失败：${loaded.error}`);
	process.exit(1);
}
const config = loaded.config;
const dataDir = join(worldDir, "v2", config.selfId);

const journal = new FactsJournal({ dataDir, selfId: config.selfId });
journal.recover();
const control = new ControlStore({ dataDir, selfId: config.selfId });
control.load();
const attention = new AttentionModel({ control });
const locks = new ConversationLocks();

for (const line of qqStatusLines(
	// CLI 不加载操作日志；unknown 计数以 0 占位（真实口径以运行中 observe scope="operations" 为准）。
	{ selfId: config.selfId, journal, control, ops: { listUnknown: () => [] } as never },
	attention,
	locks,
)) {
	console.log(line);
}
