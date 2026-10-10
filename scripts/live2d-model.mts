import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { loadModelProfile, type ModelProfile } from "../.uina/worlds/live2d/model-profile.js";
import {
	compileModelAdapter,
	suggestModelAdapter,
	type ModelAdapterDefinition,
} from "../.uina/worlds/live2d/model-adapter.js";
import {
	applyPreparation,
	planModelPreparation,
	restorePreparation,
	type PreparationPlan,
} from "../.uina/worlds/live2d/model-preparation.js";
import { VTSClient } from "../.uina/worlds/live2d/vts-client.js";

const [command, ...args] = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const required = (name: string): string => {
	const value = option(name);
	if (!value || value.startsWith("--")) throw new Error(`缺少 --${name}`);
	return value;
};
const json = async <T,>(name: string): Promise<T> => JSON.parse(await readFile(resolve(required(name)), "utf8"));
const save = async (value: unknown) =>
	writeFile(resolve(required("output")), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
async function connected<T>(run: (client: VTSClient) => Promise<T>): Promise<T> {
	const client = new VTSClient({ modelsRoot: option("models-root") });
	try {
		client.connect();
		const deadline = Date.now() + 35000;
		while (!client.isConnected() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		if (!client.isConnected()) throw new Error(client.getFault() ?? "VTS 初始化超时");
		return await run(client);
	} finally {
		client.disconnect();
	}
}

try {
	if (command === "inspect") {
		const profile = await loadModelProfile(required("model-id"), option("models-root"));
		const definition = option("definition")
			? await json<ModelAdapterDefinition>("definition")
			: suggestModelAdapter(profile);
		const report = { profile, definition, capabilities: compileModelAdapter(profile, definition).capabilities };
		if (option("output")) await save(report);
		else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else if (command === "capture") {
		await connected(async (client) => {
			await save(client.getModelProfile());
		});
	} else if (command === "plan") {
		let profile = await json<ModelProfile>("snapshot");
		if (profile.directory) {
			const fresh = await loadModelProfile(profile.modelID, dirname(profile.directory));
			const oldMoc = profile.files?.find((f) => f.path.endsWith(".moc3"));
			const newMoc = fresh.files?.find((f) => f.path.endsWith(".moc3"));
			if (!oldMoc || !newMoc || oldMoc.hash !== newMoc.hash) throw new Error("模型本体变化，需要重新 capture 真实范围");
			profile = {
				...fresh,
				parameterRanges: profile.parameterRanges,
				inputs: profile.inputs,
				adapterDefinition: profile.adapterDefinition,
				vtsVersion: profile.vtsVersion,
			};
		}
		const definition = option("definition")
			? await json<ModelAdapterDefinition>("definition")
			: (profile.adapterDefinition ?? suggestModelAdapter(profile));
		await save(await planModelPreparation(profile, definition));
	} else if (command === "inputs") {
		const plan = await json<PreparationPlan>("plan");
		await connected(async (client) => {
			const profile = client.getModelProfile()!;
			if (profile.modelID !== plan.modelID) throw new Error("活动模型与计划不匹配");
			const existing = profile.inputs ?? [];
			const missing = plan.inputs.filter((input) => !existing.some((i) => i.name === input.name));
			if (
				existing.filter((i) => i.custom && i.addedBy === "Uina Live2D VTS").length + missing.length > 100 ||
				existing.filter((i) => i.custom).length + missing.length > 300
			)
				throw new Error("VTS 自定义输入容量不足");
			for (const input of plan.inputs) {
				const found = existing.find((i) => i.name === input.name);
				if (found) {
					if (
						!found.custom ||
						found.addedBy !== "Uina Live2D VTS" ||
						found.defaultValue !== input.defaultValue ||
						found.min !== input.min ||
						found.max !== input.max
					)
						throw new Error(`同名输入的所有权或定义冲突: ${input.name}`);
				} else await client.createInput(input);
			}
		});
		process.stdout.write("输入已创建/核验；尚未应用模型绑定。\n");
	} else if (command === "apply") {
		const plan = await json<PreparationPlan>("plan");
		const definitionOutput = resolve(required("definition-output"));
		// Write the reviewable definition before changing any model files.
		await writeFile(definitionOutput, JSON.stringify(plan.definition, null, 2) + "\n", { flag: "wx" });
		const manifest = await applyPreparation(plan, resolve(required("recovery-dir")));
		process.stdout.write(`已准备模型配置。恢复清单: ${manifest}\n重新加载 VTS 并 capture 验证；未确认视觉效果。\n`);
	} else if (command === "restore") {
		await restorePreparation(resolve(required("manifest")));
		process.stdout.write("已恢复原始模型文件；未删除全局输入。\n");
	} else {
		throw new Error(
			"用法: pnpm exec tsx scripts/live2d-model.mts inspect|capture|plan|inputs|apply|restore。完整参数见 MODEL-ADAPTATION.md。",
		);
	}
} catch (error) {
	process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
	process.exitCode = 1;
}
