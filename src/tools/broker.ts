/**
 * 工具代理：注册表 + 执行。
 * 快工具同步返回；Job 类工具立即返回受理，完成后经 onJobDone 以事件回前台。
 * 执行失败不抛出——把结构化错误作为结果回注给模型，让它自己处理。
 */
import type { ToolDef } from "../core/types.js";

export interface ToolContext {
	/** 登记后台任务完成：结果将以 job_done 事件回到主体 */
	onJobDone: (jobId: string, result: string) => void;
}

export interface Tool {
	def: ToolDef;
	isJob?: boolean;
	run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolBroker {
	private readonly tools = new Map<string, Tool>();

	register(t: Tool): void {
		if (this.tools.has(t.def.function.name)) {
			throw new Error(`工具重名: ${t.def.function.name}`);
		}
		this.tools.set(t.def.function.name, t);
	}

	defs(): ToolDef[] {
		return [...this.tools.values()].map((t) => t.def);
	}

	async run(
		name: string,
		args: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<string> {
		const t = this.tools.get(name);
		if (!t) return JSON.stringify({ error: `未知工具 ${name}` });
		try {
			return await t.run(args, ctx);
		} catch (e) {
			return JSON.stringify({
				error: `${name} 执行失败: ${(e as Error).message}`,
			});
		}
	}
}
