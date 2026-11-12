import type { ExtensionAPI } from "../../../src/extensions/index.js";

/**
 * 扩展 Prompt 文件机制示例（docs/refactor/Uina-Extension-Prompt-Files-Design.md）。
 *
 * 本目录结构：
 *   prompt-file/index.ts        — 本文件：显式注册 Markdown 入口
 *   prompt-file/PROMPT.md       — 入口：可经 {{include:...}} 组合本扩展内其他 .md
 *   prompt-file/prompts/*.md    — 被 include 的局部片段
 *
 * 文件在本扩展激活时一次性编译为普通静态 guidance，与其他扩展（含内联 text）
 * 的指南一起装配为 System 后的单条固定 User 前缀；卸载或 Reload 时随作用域注销。
 */
export default async function activate(api: ExtensionAPI): Promise<void> {
	await api.provideContext({
		id: "instructions",
		kind: "guidance",
		file: "PROMPT.md",
	});
	// 其他业务能力（工具、事件、服务）独立注册，与 Prompt 入口互不依赖。
}
