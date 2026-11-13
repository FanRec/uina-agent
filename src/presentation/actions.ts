/**
 * 展示面 → 应用的动作词汇（平台中立）。
 *
 * TUI 键盘、鼠标、未来的 Web surface 都只是这些动作的来源；类型名不绑定终端。
 * 应用侧路由见 `src/cli/presentation-intents.ts`。
 */

export type PresentationIntent =
	| { readonly type: "input.submit"; readonly text: string; readonly mode: "direct" | "steer" | "followUp" }
	| { readonly type: "ui.interaction" }
	| { readonly type: "turn.cancel"; readonly source?: "escape" | "ctrl+c" }
	| { readonly type: "turn.interruptAndDeliver"; readonly text: string }
	| { readonly type: "queue.pullBack" }
	| { readonly type: "thinking.cycle" }
	/**
	 * Skill 显式调用（多前端）：结构化 name/arguments/mode，经 Host 的同一展开函数
	 * 处理；不允许调用 /reload、/quit 或任意其他斜杠命令。本地 surface 直接使用
	 * /skill 命令，不发射该意图。
	 */
	| {
			readonly type: "skill.invoke";
			readonly name: string;
			readonly arguments: string;
			readonly mode: "direct" | "steer" | "followUp";
	  };
