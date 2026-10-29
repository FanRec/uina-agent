/**
 * W0 骨架：PresentationController 的契约测试。
 *
 * 当前 UI 没有控制器（事实、投影、动作分散在 ui-host / tui / adapters 中），因此
 * 这里先以 todo 记录验收条款；W2e 接真实实现后逐条转成可执行断言，todo 同时删除。
 *
 * 契约来源：规划 §3.4 与附录 B.4。
 */

import { describe, it } from "vitest";

describe("PresentationController 契约", () => {
	it.todo("view() 在相同事实序列下返回稳定快照（两次调用逐字段相等）");
	it.todo("subscribe 只发增量事件，不重放全量视图");
	it.todo("dispatch 把 ActionId 送达 intent sink（fake surface 直接调用）");
	it.todo("replaceAll 后旧节点全部清空，不残留上一段投影");
	it.todo("applySnapshot 与 ingest 共享同一投影路径（live/replay 同构）");
});
