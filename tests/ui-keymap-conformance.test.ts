/**
 * W0 骨架：键位一致性测试（页脚提示必须与真实绑定一致）。
 *
 * 当前浮层的按键处理散落在各组件里，无法类型化抽取，因此先以 todo 记录已知失败项；
 * W5 建立 src/ui/keys/keymap.ts 后，这里改为从浮层页脚提取 token 并断言存在绑定。
 *
 * 已知失败来源：docs/history/2026-10-29-tui-display-audit.md F1/F3/F5/F7。
 */

import { describe, it } from "vitest";

describe("键位一致性", () => {
	it.todo("轨迹浮层：页脚“Enter 展开”必须有 Enter 绑定（审计 F1）");
	it.todo("提示词浮层：页脚“↑/↓ 滚动”必须有方向键绑定，并显示位置（审计 F3）");
	it.todo("帮助菜单：页脚声明的开关键必须与菜单内处理一致，不吞普通输入（审计 F5）");
	it.todo("分支检视：页脚的方向键/Enter/Esc 语义必须与当前焦点一致（审计 F7）");
	it.todo("每个可交互浮层都有 capturing keymap，且提示文本由绑定生成");
});
