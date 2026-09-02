/**
 * 工具代理：注册表 + 执行。
 * 执行失败不抛出——把结构化错误作为结果回注给模型，让它自己处理。
 */
import type { ToolDef } from "../core/types.js";

export interface Tool {
	def: ToolDef;
	run(args: Record<string, unknown>): Promise<string>;
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

	async run(name: string, args: Record<string, unknown>): Promise<string> {
		const t = this.tools.get(name);
		if (!t) return JSON.stringify({ error: `未知工具 ${name}` });
		try {
			return await t.run(args);
		} catch (e) {
			return JSON.stringify({
				error: `${name} 执行失败: ${(e as Error).message}`,
			});
		}
	}
}
