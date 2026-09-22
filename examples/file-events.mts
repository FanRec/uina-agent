import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JobRegistry } from "../src/extensions/jobs/registry.js";
import { createJobTools } from "../src/extensions/jobs/tools.js";
import { createExecCommandTool } from "../src/extensions/runtime-tools/exec-command/index.js";

/** Opt-in example. Load through .uina/extensions and set UINA_WATCH_FILE. */
export default async function activate(pi: import("../src/extensions/runner.js").ExtensionAPI) {
	if (!process.env.UINA_WATCH_FILE) throw new Error("file-events 需要 UINA_WATCH_FILE");
	const path = resolve(process.env.UINA_WATCH_FILE);
	let previous = await readFile(path, "utf8");
	let active = true;
	const cancellation = new AbortController();
	let reads = Promise.resolve();
	const jobs = new JobRegistry();
	const owner = pi.id;
	pi.registerTool({
		def: { type: "function", function: { name: "watch_silence", description: "决定无需对外表达时调用。记录本次决定并结束本轮，不再生成回复文本。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
		run: async () => ({ result: "本次观察无需对外表达。", status: "succeeded", continuation: "stop" }),
	});
	const shell = createExecCommandTool(jobs, owner);
	pi.registerTool({ ...shell,
		run: (args, signal) => active
			? shell.run(args, signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal)
			: Promise.resolve({ result: "文件观察已停止，未启动命令。", status: "not_started" }),
		def: { ...shell.def, function: { ...shell.def.function, name: "watch_exec", description: `${shell.def.function.description} 文件事件的长工作应设置 run_in_background=true；后台结果用 watch_job_output 读取。` } },
	});
	for (const tool of createJobTools(jobs, owner)) {
		if (tool.def.function.name === "job_output") continue;
		pi.registerTool({ ...tool, def: { ...tool.def, function: { ...tool.def.function, name: `watch_${tool.def.function.name}` } } });
	}
	pi.registerTool({
		def: { type: "function", function: { name: "watch_job_output", description: "立即读取后台工作的输出快照。工作结束会主动通知；状态仍 running 时结束本轮，不轮询等待。", parameters: { type: "object", properties: { job_id: { type: "string" }, cursor: { type: "integer", minimum: 0 } }, required: ["job_id"], additionalProperties: false } } },
		run: async args => ({ result: JSON.stringify(jobs.read(String(args.job_id), owner, typeof args.cursor === "number" ? args.cursor : 0)), status: "succeeded" }),
	});
	const report = (error: unknown) => pi.reportError(new Error(`[file-events:${path}] ${String(error)}`));
	const unsubscribe = jobs.onResolved(job => {
		if (!active) return;
		void pi.submitInput({ id: randomUUID(), mode: "followUp", source: { kind: "runtime", type: "watch-job", ref: job.id }, text: `观察扩展的后台工作已结束：${job.status}。可用 watch_job_output 读取 ${job.id}，按需表达或保持安静。`, data: job }).catch(report);
	});
	const watcher = watch(dirname(path), (_event, filename) => {
		if (filename && filename.toString() !== basename(path)) return;
		reads = reads.then(async () => {
			if (!active) return;
			const content = await readFile(path, "utf8");
			if (!active || content === previous) return;
			previous = content;
			// Queue the observation without waiting for the model on the file-read path.
				// origin: external —— 文件变化来自外部世界，投影层将以 external_event_frame 呈现。
				void pi.submitInput({ id: randomUUID(), mode: "steer", source: { kind: "runtime", type: "file-changed", ref: path, origin: "external" }, text: `文件 ${path} 发生变化。以下是文件内容，不是人类发言：\n${content}\n根据实际需要决定行动；长命令用 watch_exec 的后台模式，不需要对外表达时调用 watch_silence，不要先输出解释。`, data: { path, observedAt: Date.now() } }).catch(report);
		}).catch(report);
	});
	watcher.on("error", report);
	let stopping: Promise<void> | undefined;
	const stop = () => stopping ??= (async () => {
		active = false;
		cancellation.abort();
		watcher.close();
		unsubscribe();
		await jobs.close();
		await reads;
	})();
	pi.registerCommand({ name: "watch-stop", description: "停止文件观察并取消观察扩展的后台工作", handler: stop });
	return stop;
}
