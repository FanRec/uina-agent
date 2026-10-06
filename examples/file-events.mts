import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createExecCommandTool } from "../src/extensions/runtime-tools/exec-command/index.js";

/** Opt-in example. Load through .uina/extensions and set UINA_WATCH_FILE. */
export default async function activate(pi: import("../src/extensions/runner.js").ExtensionAPI) {
	if (!process.env.UINA_WATCH_FILE) throw new Error("file-events 需要 UINA_WATCH_FILE");
	const path = resolve(process.env.UINA_WATCH_FILE);
	let previous = await readFile(path, "utf8");
	let active = true;
	const cancellation = new AbortController();
	let reads = Promise.resolve();
	pi.registerTool({
		def: {
			type: "function",
			function: {
				name: "watch_silence",
				description: "决定无需对外表达时调用。记录本次决定并结束本轮，不再生成回复文本。",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		},
		run: async () => ({ result: "本次观察无需对外表达。", status: "succeeded", continuation: "stop" }),
	});
	const shell = createExecCommandTool();
	pi.registerTool({
		...shell,
		run: (args, signal) =>
			active
				? shell.run(args, signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal)
				: Promise.resolve({ result: "文件观察已停止，未启动命令。", status: "not_started" }),
		def: {
			...shell.def,
			function: {
				...shell.def.function,
				name: "watch_exec",
				description: `${shell.def.function.description} 观察到的文件事件驱动本工具；长命令会阻塞本轮，请合理设置 timeout。`,
			},
		},
	});
	const report = (error: unknown) => pi.reportError(new Error(`[file-events:${path}] ${String(error)}`));
	const watcher = watch(dirname(path), (_event, filename) => {
		if (filename && filename.toString() !== basename(path)) return;
		reads = reads
			.then(async () => {
				if (!active) return;
				const content = await readFile(path, "utf8");
				if (!active || content === previous) return;
				previous = content;
				// Queue the observation without waiting for the model on the file-read path.
				// origin: external —— 文件变化来自外部世界，投影层将以 external_event_frame 呈现。
				void pi
					.submitInput({
						id: randomUUID(),
						mode: "steer",
						source: { kind: "runtime", type: "file-changed", ref: path, origin: "external" },
						text: `文件 ${path} 发生变化。以下是文件内容，不是人类发言：\n${content}\n根据实际需要决定行动；命令用 watch_exec 执行，不需要对外表达时调用 watch_silence，不要先输出解释。`,
						data: { path, observedAt: Date.now() },
					})
					.catch(report);
			})
			.catch(report);
	});
	watcher.on("error", report);
	let stopping: Promise<void> | undefined;
	const stop = () =>
		(stopping ??= (async () => {
			active = false;
			cancellation.abort();
			watcher.close();
			await reads;
		})());
	pi.registerCommand({ name: "watch-stop", description: "停止文件观察并取消观察扩展的进行中命令", handler: stop });
	return stop;
}
