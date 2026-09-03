import type { ExtensionRegistry } from "../ui/extensions/registry.js";

/** One command path for terminal UI, pipe/stdin and one-shot execution. */
export class CommandRouter {
	constructor(private readonly registry: ExtensionRegistry, private readonly report: (message: string) => void) {}

	async dispatch(input: string): Promise<boolean> {
		if (!input.startsWith("/")) return false;
		const [name = "", ...rest] = input.slice(1).trim().split(/\s+/);
		if (!name) return true;
		const command = this.registry.getCommand(name.toLowerCase());
		if (!command?.handler) {
			this.report(`未知命令: /${name}。输入 /help 查看命令。`);
			return true;
		}
		try { await command.handler(rest.join(" ")); }
		catch (error) { this.report(`/${name} 执行失败: ${error instanceof Error ? error.message : String(error)}`); }
		return true;
	}
}
