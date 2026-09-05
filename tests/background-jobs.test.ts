import { afterEach, describe, expect, it } from "vitest";
import { ToolBroker } from "../src/tools/broker.js";
import { JobRegistry } from "../src/extensions/jobs/registry.js";
import { createJobTools } from "../src/extensions/jobs/tools.js";
import { createExecCommandTool } from "../src/extensions/runtime-tools/exec-command/index.js";
import { Subject } from "../src/agent/loop.js";
import { scriptedProvider, lastUser } from "./helpers/mock-provider.js";

const registries: JobRegistry[] = [];
afterEach(async () => {
	for (const registry of registries.splice(0)) await registry.close();
});

function make(): { jobs: JobRegistry; broker: ToolBroker } {
	const jobs = new JobRegistry();
	registries.push(jobs);
	const broker = new ToolBroker();
	broker.register(createExecCommandTool(jobs, "root"));
	for (const tool of createJobTools(jobs, "root")) broker.register(tool);
	return { jobs, broker };
}

describe("background jobs", () => {
	it("publishes a job only after its producer handle is available", () => {
		const { jobs } = make();
		expect(() => jobs.start({
			label: "broken startup",
			ownerId: "root",
			source: { extension: "test" },
			start: () => { throw new Error("producer unavailable"); },
		})).toThrow("后台任务启动失败：producer unavailable");
		expect(jobs.list("root")).toEqual([]);
	});

	it("returns a job id immediately and exposes live output and source", async () => {
		const { jobs, broker } = make();
		const started = JSON.parse(await broker.run("exec_command", {
			command: "node -e \"process.stdout.write('hello')\"",
			run_in_background: true,
		}));
		expect(started.status).toBe("running");
		expect(typeof started.jobId).toBe("string");
		const id = started.jobId as string;
		const snapshot = jobs.get(id, "root");
		expect(snapshot.source).toEqual({ extension: "shell", operation: "exec" });
		let output = JSON.parse(await broker.run("job_output", { job_id: id }));
		let text = output.text as string;
		while (output.job.status === "running" || output.job.status === "stopping") {
			await jobs.wait(id, "root", 5000, output.cursor);
			output = JSON.parse(await broker.run("job_output", { job_id: id, cursor: output.cursor }));
			text += output.text as string;
		}
		expect(text).toContain("hello");
		expect(output.job.status).toBe("completed");
	});

	it("reads output incrementally and preserves metadata", async () => {
		const { jobs } = make();
		let release!: () => void;
		const id = jobs.start({
			label: "incremental",
			ownerId: "root",
			source: { extension: "test", operation: "stream" },
			start: (context) => {
				const done = new Promise<void>((resolve) => { release = resolve; });
				context.update({ detail: "working", progress: { current: 1, total: 2 } });
				context.observe({ stream: "text", text: "one" });
				return { cancel: () => release(), done: done.then(() => ({ status: "completed" as const, output: { result: "done" } })) };
			},
		});
		const first = jobs.read(id, "root");
		expect(first.text).toBe("one");
		expect(first.cursor).toBeGreaterThan(0);
		const second = jobs.read(id, "root", first.cursor);
		expect(second.text).toBe("");
		expect(jobs.get(id, "root")).toMatchObject({ detail: "working", progress: { current: 1, total: 2 } });
		release();
		await jobs.wait(id, "root", 5000, first.cursor);
		while (jobs.get(id, "root").status === "running" || jobs.get(id, "root").status === "stopping") {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(jobs.read(id, "root").result).toBe("done");
	});

	it("does not expose jobs to another owner and cancellation waits for producer settlement", async () => {
		const { jobs } = make();
		let release!: () => void;
		const id = jobs.start({
			label: "cancellable",
			ownerId: "root",
			source: { extension: "test" },
			start: () => ({
				cancel: () => release(),
				done: new Promise((resolve) => { release = () => resolve({ status: "killed" as const }); }),
			}),
		});
		expect(() => jobs.get(id, "other")).toThrow();
		expect(jobs.cancel(id, "root", "stop")).toBe("cancellation-requested");
		expect(jobs.get(id, "root").status).toBe("stopping");
		release();
		await jobs.wait(id, "root", 5000);
		expect(jobs.get(id, "root").status).toBe("killed");
	});

	it("delivers a runtime notice without adding a user message to history", async () => {
		const provider = scriptedProvider([{ match: () => true, produce: () => [{ kind: "text", text: "ack" }] }]);
		const subject = new Subject(provider, new ToolBroker(), { onToken: () => {} });
		await subject.accept({
			id: "notice-1",
			mode: "followUp",
			source: { kind: "runtime", type: "job-notice", ref: "job-1" },
			text: "后台任务 job-1 已完成",
		});
		while (subject.isBusy()) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(subject.historySnapshot().filter((message) => message.role === "user")).toHaveLength(0);
		expect(provider.calls[0]?.messages.some((message) => message.content.includes("job-notice"))).toBe(true);
		expect(lastUser(provider.calls[0])).toContain("[运行时事件 job-notice");
	});
});
