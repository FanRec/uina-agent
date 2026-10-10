import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { VTSClient } from "../.uina/legacy/live2d/vts-client.js";
import { Live2DRuntime } from "../.uina/legacy/live2d/runtime.js";
import { loadModelProfile, type ModelProfile } from "../.uina/legacy/live2d/model-profile.js";
import { loadModelPackage } from "../.uina/legacy/live2d/models/index.js";
import { PackageProgram, type VisualAcceptance } from "../.uina/legacy/live2d/model-package.js";
import {
	planModelPreparation,
	applyPreparation,
	restorePreparation,
	type PreparationPlan,
} from "../.uina/legacy/live2d/model-preparation.js";
import type { ModelRig } from "../.uina/legacy/live2d/model-adapter.js";
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const required = (name: string) => {
	const v = option(name);
	if (!v || v.startsWith("--")) throw new Error(`缺少 --${name}`);
	return v;
};
const read = async <T,>(name: string): Promise<T> => JSON.parse(await readFile(resolve(required(name)), "utf8"));
const output = async (value: unknown) => {
	if (option("output"))
		await writeFile(resolve(required("output")), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
	else console.log(JSON.stringify(value, null, 2));
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function connected<T>(run: (client: VTSClient) => Promise<T>): Promise<T> {
	const client = new VTSClient();
	try {
		client.connect();
		const deadline = Date.now() + 15000;
		while (!client.isConnected() && Date.now() < deadline) await wait(100);
		if (!client.isConnected()) throw new Error(client.getFault() ?? "VTS 未就绪");
		return await run(client);
	} finally {
		client.disconnect();
	}
}
try {
	if (command === "capture") await connected(async (c) => output(c.getModelProfile()));
	else if (command === "inspect") {
		const p = await loadModelProfile(required("model-id"), option("models-root"));
		await output(p);
	} else if (command === "plan") {
		const captured = await read<ModelProfile>("snapshot"),
			rig = await read<ModelRig>("rig");
		const fresh = await loadModelProfile(captured.modelID, dirname(captured.directory!));
		if (
			captured.files?.find((f) => f.path.endsWith(".moc3"))?.hash !==
			fresh.files?.find((f) => f.path.endsWith(".moc3"))?.hash
		)
			throw new Error("模型本体改变，需重新捕获范围");
		await output(
			await planModelPreparation({ ...fresh, parameterRanges: captured.parameterRanges, inputs: captured.inputs }, rig),
		);
	} else if (command === "apply") {
		const plan = await read<PreparationPlan>("plan");
		console.log(await applyPreparation(plan, resolve(required("recovery-dir"))));
	} else if (command === "restore") await restorePreparation(resolve(required("manifest")));
	else if (command === "reload") await connected((c) => c.reloadCurrentModel());
	else if (command === "accept") {
		const evidence = required("evidence");
		await readFile(resolve(evidence));
		await connected(async (c) => {
			const profile = c.getModelProfile()!,
				pkg = await loadModelPackage(profile);
			if (!pkg) throw new Error("模型未适配");
			const p = new PackageProgram(pkg, profile);
			if (required("content-digest") !== p.digest) throw new Error("验收版本与当前内容不符");
			const acceptance: VisualAcceptance = {
				contentDigest: p.digest,
				controlFingerprint: profile.controlFingerprint!,
				evidence,
			};
			await output(acceptance);
		});
	} else if (command === "preview" || command === "diagnose") {
		await connected(async (client) => {
			const runtime = new Live2DRuntime({ vtsClient: client });
			await runtime.synchronize();
			if (command === "diagnose") return output(runtime.diagnostics());
			await runtime.start();
			try {
				const ctx = { signal: new AbortController().signal };
				const result = await runtime.preview(
					{
						motion: option("motion"),
						pose: option("pose"),
						control: option("control"),
						keys: option("keys") ? JSON.parse(required("keys")) : undefined,
						repeat: option("repeat") ? Number(required("repeat")) : undefined,
						background: option("background") === "true",
					},
					ctx,
				);
				if (result.status !== "succeeded") throw new Error(JSON.stringify(result));
				await wait(Number(option("hold-ms") ?? 300));
				await output({ result, diagnostics: runtime.diagnostics() });
			} finally {
				await runtime.stop();
			}
		});
	} else
		throw new Error(
			"命令: capture / inspect / plan / apply / restore / diagnose / preview / reload / accept；详见 Live2D README。",
		);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
