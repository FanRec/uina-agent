import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { UinaHost } from "../src/host/host.js";
import { Scenario } from "./harness/index.js";

describe("Host delivery crash boundary", () => {
	for (const boundary of ["before", "after"] as const)
		it(`recovers actual disk facts when killed ${boundary} canonical append`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "uina-delivery-crash-"));
			const path = join(dir, "session.jsonl");
			const artifact = process.env.UINA_DELIVERY_ARTIFACT === "dist";
			const hostModule = pathToFileURL(
				join(process.cwd(), artifact ? "dist/src/host/host.js" : "src/host/host.ts"),
			).href;
			const Host: typeof UinaHost = artifact ? (await import(hostModule)).UinaHost : UinaHost;
			const code = `
import { UinaHost } from ${JSON.stringify(hostModule)};
process.on('message', () => {});
const hold = () => new Promise(() => {});
const mode = process.env.DELIVERY_BOUNDARY;
let calls = 0;
const host = await UinaHost.create({ cwd: process.env.DELIVERY_DIR, sessionPath: process.env.DELIVERY_PATH,
  model: { id: 'test', name: 'test', providerId: 'test', contextWindow: 128000 },
  stream: async (_m, _req, emit) => {
    if (calls++ === 0) {
      emit({kind:'tool_call',call:{id:'c',name:'probe',args:'{}',argsValid:true}});
      emit({kind:'finish',reason:'tool_calls'});
    } else { process.send({boundary:'after'}); await hold(); }
  }
});
await host['extensionHost'].activateBuiltin('producer', pi => {
  pi.registerTool({ def:{type:'function',function:{name:'probe',description:'probe',parameters:{type:'object',properties:{}}}},
    run: async () => ({result:'fixed report',status:'succeeded',receipt:{key:'k',attempt:'a'}}) });
  if (mode === 'before') pi.onHook('tools.transformResult', async () => {
    const state = await pi.delivery().inspect('k');
    process.send({boundary:'before',state}); await hold();
  });
});
await host.subject.pushInput('go');
`;
			const child = spawn(
				process.execPath,
				[...(artifact ? [] : ["--import", "tsx"]), "--input-type=module", "-e", code],
				{
					cwd: process.cwd(),
					env: { ...process.env, DELIVERY_BOUNDARY: boundary, DELIVERY_DIR: dir, DELIVERY_PATH: path },
					stdio: ["ignore", "ignore", "pipe", "ipc"],
					windowsHide: true,
				},
			);
			let stderr = "";
			child.stderr!.on("data", (chunk) => {
				stderr += chunk;
			});
			const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
				child.once("message", (value) => resolve(value as Record<string, unknown>));
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
			});
			try {
				const signal = await ready;
				expect(signal.boundary).toBe(boundary);
				if (boundary === "before") expect(signal.state).toMatchObject({ kind: "pending", channel: "tool" });
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
				const scenario = new Scenario();
				const host = await Host.create({
					cwd: dir,
					sessionPath: path,
					model: scenario.model,
					stream: scenario.stream,
				});
				try {
					const state = await host.subject.delivery(JSON.stringify(["builtin:producer", ""])).inspect("k");
					expect(state.kind).toBe(boundary === "after" ? "committed" : "absent");
				} finally {
					await host.dispose();
				}
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}
				await rm(dir, { recursive: true, force: true });
			}
		}, 15000);
});
