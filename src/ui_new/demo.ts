/**
 * 独立的 TUI 交互沙盒（用于实机验证与体验）。
 * 运行方式：pnpm tsx src/ui_new/demo.ts
 */

import { UinaTUI } from "./tui.js";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const tui = new UinaTUI({
		modelName: "deepseek-chat",
		toolCount: 6,
	});

	tui.onInterrupt(() => {
		tui.stop();
		process.stdout.write("\n已安全退出沙盒。\n");
		process.exit(0);
	});

	let isTurnRunning = false;
	let turnCounter = 1;

	tui.onUserInput(async (input) => {
		const text = input.trim();
		if (text === "/quit" || text === "exit") {
			tui.stop();
			process.stdout.write("\n已安全退出沙盒。\n");
			process.exit(0);
		}

		if (isTurnRunning) {
			return;
		}
		isTurnRunning = true;
		const turnNum = turnCounter++;

		try {
			if (text === "2" || text.includes("tool")) {
				// 场景 2：工具调用原地坍缩（绝不产生双行废痕）
				tui.handleTurnStart(turnNum, input);

				tui.appendToken("收到，正在为你调用终端命令执行回归测试...\n");
				await sleep(600);

				const toolTs = Date.now();
				tui.handleToolStart("exec_command", { command: "pnpm test --run" });
				await sleep(1300);

				tui.handleToolDone(
					"exec_command",
					JSON.stringify({
						stdout: "✓ tests/smoke.test.ts (29 tests passed)\nTest Files  3 passed (3)\nDuration 1.2s",
						code: 0,
					}),
					Date.now() - toolTs,
				);
				await sleep(500);

				tui.appendToken("命令执行完成，测试全部通过。\n");
				tui.handleTurnEnd(turnNum, { usedTokens: 18400, contextWindow: 65536 });
				return;
			}

			if (text === "3" || text.includes("think")) {
				// 场景 3：DeepSeek-R1 深度思考流、实时展开与多轮交互
				tui.handleTurnStart(turnNum, input);

				const thinkFragments = [
					"分析问题意图与系统架构约束...\n",
					"捕获 ANSI SGR 鼠标跟踪协议，构建视口行号几何映射...\n",
					"采用 pi 差量覆写与确定性 2K 清行，彻底消除 Jina 光标覆盖...\n",
					"采用 dsh-TUI 5x5 平滑连贯字形重绘 UINA 标题...\n",
					"实现流式双态流光容器，注入实时动态光标 █...\n",
					"调整垂直节奏，增加全屏呼吸间距与 4 面全封闭代码盒...\n",
					"结论：视觉与逻辑双重就绪，架构完备。",
				];

				for (const frag of thinkFragments) {
					tui.appendThinking(frag);
					await sleep(450);
				}

				await sleep(500);
				tui.appendToken(
					"推理完成。现在你可以：\n- **Ctrl+O**：极速展开/折叠最新那一轮的思考内容；\n- **Alt+O**：一键全部展开 / 全部折叠！\n- **/think [n]**：按轮次单独展开/折叠指定轮次（如 `/think 1`）！\n",
				);
				tui.handleTurnEnd(turnNum, { usedTokens: 25600 + turnNum * 1200, contextWindow: 65536 });
				return;
			}

			if (text === "4" || text.includes("diff")) {
				// 场景 4：Git Unified Diff 差异视图卡片
				tui.handleTurnStart(turnNum, input);
				tui.appendToken("收到，已为你修改目标文件，正在生成代码变更 Unified Diff 卡片：\n");
				await sleep(400);

				const oldCode = `export interface UserConfig {
  theme: "dark" | "light";
  enableThinking: boolean;
  maxTokens: number;
}`;
				const newCode = `export interface UserConfig {
  theme: "dark" | "light" | "cyberpunk";
  enableThinking: boolean;
  reasoningEffort: "low" | "medium" | "high";
  maxTokens: number;
  verbose: boolean;
}`;
				tui.appendDiff(oldCode, newCode, "src/config/user.ts");
				await sleep(500);

				tui.appendToken("\n代码变更已就绪！提示：输入 `/diff` 可一键展开/折叠差异卡片。\n");
				tui.handleTurnEnd(turnNum, { usedTokens: 29800, contextWindow: 65536 });
				return;
			}

			if (text === "5" || text.includes("compact")) {
				// 场景 5：会话压缩演练（/compact）
				tui.handleTurnStart(turnNum, input);
				tui.appendToken("收到，正在为你生成前置会话总结并释放上下文配额：\n");
				await sleep(300);
				await tui.compact(
					"## 会话历史压缩总结\n• 深入梳理了系统架构约束与极速响应链路；\n• 成功落地输入增强体系（/ 命令联想与 @ 文件双模穿梭）；\n• 实现了 Git Unified Diff 封闭细线对比卡片与折叠交互。\n上下文释放约 21.6k tokens。",
					21600,
				);
				tui.handleTurnEnd(turnNum, { usedTokens: 8200, contextWindow: 65536 });
				return;
			}

			if (text === "6" || text.includes("table")) {
				// 场景 6：第二梯队 Markdown 原生表格与多语言语法高亮演示
				tui.handleTurnStart(turnNum, input);
				tui.appendToken("正在为你汇总当前第二梯队核心组件的基准测试结果：\n\n");
				await sleep(300);

				const tableMarkdown = `| 核心模块 | 渲染规范 | 响应耗时 | 状态 |
| :--- | :--- | :---: | ---: |
| SyntaxText 语法高亮 | 暗色终端 ANSI SGR | 4.2ms | 就绪 |
| MarkdownTable 自适应表格 | Unicode 细线全封闭网格 | 1.8ms | 就绪 |
| ModelPicker 切模型浮层 | 两级下钻半模态浮层 | 0.9ms | 就绪 |
| EffortSlider 思考滑块 | 拟态变阻器 (5 挡：Off/Low/Med/High/Max) | 0.6ms | 就绪 |
| HelpMenu 帮助抽屉 | 双栏快捷键与指令抽屉 | 0.5ms | 就绪 |

`;
				for (const chunk of tableMarkdown.split("\n")) {
					tui.appendToken(`${chunk}\n`);
					await sleep(60);
				}

				await sleep(200);
				tui.appendToken("\n### 样例代码展示（SyntaxText 彩色语法着色）\n\n");
				const codeBlock = `\`\`\`typescript
export async function bootstrapAgent(): Promise<UinaAgent> {
  const tui = new UinaTUI({ modelName: "deepseek-reasoner" });
  await tui.setReasoningEffort("high");
  return new UinaAgent({ tui });
}
\`\`\`
`;
				for (const chunk of codeBlock.split("\n")) {
					tui.appendToken(`${chunk}\n`);
					await sleep(80);
				}

				tui.appendToken("\n表格与代码块均已完成自适应对齐与语法着色。\n");
				tui.handleTurnEnd(turnNum, { usedTokens: 16500, contextWindow: 65536 });
				return;
			}

			if (text === "7" || text.includes("subagent") || text.includes("agent")) {
				// 场景 7：第三梯队 多子智能体一级看板与二级全屏审查演练
				tui.openSubagents();
				return;
			}

			if (text === "8" || text.includes("task") || text.includes("job")) {
				// 场景 8：第三梯队 后台任务与长驻进程看板 (TaskDashboard) 演练
				tui.openTasks();
				return;
			}

			if (text === "9" || text.includes("traj") || text.includes("trajectory")) {
				// 场景 9：第三梯队 全屏审计轨迹看板 (TrajectoryScene) 演练
				tui.openTrajectory();
				return;
			}

			// 默认场景 1：现代精修流式 Markdown 体验
			tui.handleTurnStart(turnNum, input);

			const markdownChunks = [
				"# 认知架构与极速响应\n\n",
				"本系统结合了 **dsh-TUI 的视觉面子** 与 **pi 的架构里子**：\n\n",
				"- 响应延迟：端到端音频与认知链路 < 1.8s\n",
				"- 硬件光标锁死：原生中文 `IME` 选词框精准吸附，绝不漂移\n",
				"- 状态动效：冰蓝流光扫光（Shimmer Sweep）与实时 TPS\n\n",
				"```typescript\n",
				"interface SoulInComputer {\n",
				'  agent: "Uina";\n',
				"  alive: true;\n",
				"}\n",
				"```\n\n",
				"> 快捷体验提示：\n> • 按 `Alt+T` 或输入 `/trajectory` 打开全屏审计轨迹 (WaveBand波形与Hotspot热点)\n> • 按 `Alt+J` 或输入 `/tasks` 打开后台任务看板 (双分屏实时日志透视)\n> • 按 `Alt+A` 或输入 `/subagents` 打开多子智能体看板与二级详情审查\n> • 按 `Shift+Tab` 循环切换思考强度（5 档变阻器，底栏即时响应）\n> • 空行直接敲 `?` 或输入 `/help` 唤起帮助抽屉\n> • 输入 `/model` 唤起半模态切模型浮层\n> • 输入 `/effort` 唤起思考强度拟态滑块\n> • 输入 `9` 直达全屏审计轨迹看板\n> • 输入 `8` 直达后台任务看板\n> • 输入 `7` 直达多子智能体看板\n> • 输入 `6` 体验原生表格自适应与代码高亮\n> • 输入 `5` 体验会话压缩 (∴)\n> • 输入 `4` 体验 Diff 差异卡片\n> • 输入 `3` 体验 DeepSeek-R1 深度思考流\n> • 输入 `/` 体验斜杠指令联想，输入 `@` 体验文件模糊联想\n",
			];
			for (const chunk of markdownChunks) {
				tui.appendToken(chunk);
				await sleep(80);
			}

			tui.handleTurnEnd(turnNum, { usedTokens: 14200 + turnNum * 800, contextWindow: 65536 });
		} finally {
			isTurnRunning = false;
		}
	});

	tui.start();
}

void main();
