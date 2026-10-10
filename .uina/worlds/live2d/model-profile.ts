import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { ModelAdapterDefinition } from "./model-adapter.js";
import { promisify } from "node:util";

export interface ModelMapping {
	input: string;
	output: string;
	inputMin: number;
	inputMax: number;
	outputMin: number;
	outputMax: number;
	useBreathing?: boolean;
	useBlinking?: boolean;
	clampInput?: boolean;
	clampOutput?: boolean;
	smoothing?: number;
	index?: number;
}
export interface ModelParameterRange {
	min: number;
	max: number;
	defaultValue: number;
	value?: number;
}
export interface ModelInput extends ModelParameterRange {
	name: string;
	addedBy?: string;
	custom?: boolean;
}
export interface PhysicsGroup {
	id: string;
	inputs: readonly { id: string; weight: number }[];
	outputs: readonly { id: string; weight: number; scale: number }[];
}
export interface ModelSource {
	file: string;
	kind: "expression" | "motion";
	parameters: readonly string[];
}
export interface ModelFile {
	path: string;
	hash: string;
}
export interface ModelProfile {
	adapterDefinition?: ModelAdapterDefinition;
	modelID: string;
	modelName: string;
	mappings: readonly ModelMapping[];
	physicsOutputs: readonly string[];
	parameterRanges?: Readonly<Record<string, ModelParameterRange>>;
	inputs?: readonly ModelInput[];
	physicsGroups?: readonly PhysicsGroup[];
	physicsState?: Record<string, unknown>;
	vtsVersion?: string;
	sources?: readonly ModelSource[];
	activeExpressions?: readonly string[];
	fingerprint?: string;
	directory?: string;
	configFile?: string;
	files?: readonly ModelFile[];
	assetListing?: readonly string[];
	config?: Record<string, unknown>;
	diagnostics?: readonly string[];
}
export const hashContent = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

/** All model references must stay inside the selected model, including through links. */
export async function modelFilePath(directory: string, reference: string): Promise<string> {
	const root = await realpath(directory);
	const path = await realpath(resolve(root, reference));
	const rel = relative(root, path);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`模型文件引用越界: ${reference}`);
	return path;
}

/** Reads saved facts without discarding built-in, constant, malformed or duplicate bindings. */
export async function loadModelProfile(modelID: string, modelsRoot?: string): Promise<ModelProfile> {
	let root = modelsRoot ?? process.env.UINA_VTS_MODELS_DIR;
	if (!root && process.platform === "win32") {
		const { stdout } = await promisify(execFile)(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "(Get-Process 'VTube Studio' | Select-Object -First 1).Path"],
			{ windowsHide: true, timeout: 3000, encoding: "utf8" },
		);
		if (stdout.trim()) root = join(dirname(stdout.trim()), "VTube Studio_Data", "StreamingAssets", "Live2DModels");
	}
	if (!root) throw new Error("找不到 VTS 模型目录；请设置 UINA_VTS_MODELS_DIR。");
	const matches: { directory: string; file: string; config: Record<string, unknown>; content: string }[] = [];
	for (const folder of await readdir(root, { withFileTypes: true })) {
		if (!folder.isDirectory()) continue;
		const directory = join(root, folder.name);
		for (const file of await readdir(directory)) {
			if (!file.endsWith(".vtube.json")) continue;
			try {
				const content = await readFile(join(directory, file), "utf8");
				const config = JSON.parse(content);
				if (config.ModelID === modelID) matches.push({ directory, file, config, content });
			} catch {
				/* Unrelated broken models are not the current model. */
			}
		}
	}
	if (!matches.length) throw new Error(`找不到当前 VTS 模型 ${modelID} 的保存配置。`);
	if (matches.length !== 1) throw new Error(`模型 ID 重复，不能选择第一个匹配: ${modelID}`);
	const { directory, file, config, content } = matches[0]!;
	const diagnostics: string[] = [];
	if (!Array.isArray(config.ParameterSettings)) throw new Error("模型参数设置不是数组");
	const files: ModelFile[] = [{ path: join(directory, file), hash: hashContent(content) }];
	const readJSON = async (reference: string): Promise<Record<string, unknown>> => {
		const path = await modelFilePath(directory, reference);
		const bytes = await readFile(path);
		files.push({ path, hash: hashContent(bytes) });
		return JSON.parse(bytes.toString("utf8"));
	};
	const mappings: ModelMapping[] = config.ParameterSettings.map((item, index) => {
		const numbers = [item.InputRangeLower, item.InputRangeUpper, item.OutputRangeLower, item.OutputRangeUpper];
		if (!numbers.every(Number.isFinite) || typeof item.Input !== "string" || typeof item.OutputLive2D !== "string")
			diagnostics.push(`绑定 ${index}: 非法字段`);
		return {
			input: item.Input,
			output: item.OutputLive2D,
			inputMin: numbers[0],
			inputMax: numbers[1],
			outputMin: numbers[2],
			outputMax: numbers[3],
			useBreathing: item.UseBreathing === true,
			useBlinking: item.UseBlinking === true,
			clampInput: item.ClampInput === true,
			clampOutput: item.ClampOutput === true,
			smoothing: item.Smoothing,
			index,
		};
	});
	const physicsGroups: PhysicsGroup[] = [];
	const sources: ModelSource[] = [];
	const assetListing = (await readdir(directory, { recursive: true }))
		.filter((f) => /\.(exp3|motion3|model3|physics3|cdi3)\.json$|\.moc3$|\.png$/i.test(f))
		.sort();
	const references = config.FileReferences as { Model?: string } | undefined;
	if (references?.Model) {
		const model = await readJSON(references.Model);
		const refs = model.FileReferences as
			| {
					Moc?: string;
					Physics?: string;
					Expressions?: { File: string }[];
					Motions?: Record<string, { File: string }[]>;
			  }
			| undefined;
		if (refs?.Moc) {
			const path = await modelFilePath(directory, join(dirname(references.Model), refs.Moc));
			files.push({ path, hash: hashContent(await readFile(path)) });
		}
		if (refs?.Physics) {
			const physics = await readJSON(join(dirname(references.Model), refs.Physics));
			for (const group of (physics.PhysicsSettings ?? []) as {
				Id?: string;
				Input?: { Source?: { Id?: string }; Weight?: number }[];
				Output?: { Destination?: { Id?: string }; Weight?: number; Scale?: number }[];
			}[]) {
				physicsGroups.push({
					id: group.Id ?? "",
					inputs: (group.Input ?? []).map((x) => ({ id: x.Source?.Id ?? "", weight: x.Weight ?? NaN })),
					outputs: (group.Output ?? []).map((x) => ({
						id: x.Destination?.Id ?? "",
						weight: x.Weight ?? NaN,
						scale: x.Scale ?? NaN,
					})),
				});
			}
		}
		const expressionFiles = new Set((refs?.Expressions ?? []).map((x) => join(dirname(references.Model!), x.File)));
		for (const f of assetListing) if (f.endsWith(".exp3.json")) expressionFiles.add(f);
		for (const f of expressionFiles) {
			const expression = await readJSON(f);
			sources.push({
				file: f,
				kind: "expression",
				parameters: ((expression.Parameters ?? []) as { Id: string }[]).map((p) => p.Id),
			});
		}
		const motionFiles = new Set(
			Object.values(refs?.Motions ?? {})
				.flat()
				.map((x) => join(dirname(references.Model!), x.File)),
		);
		for (const f of assetListing) if (f.endsWith(".motion3.json")) motionFiles.add(f);
		for (const f of motionFiles) {
			const motion = await readJSON(f);
			sources.push({
				file: f,
				kind: "motion",
				parameters: ((motion.Curves ?? []) as { Target: string; Id: string }[])
					.filter((p) => p.Target === "Parameter")
					.map((p) => p.Id),
			});
		}
	}
	const physicsEnabled = (config.PhysicsSettings as { Use?: boolean } | undefined)?.Use === true;
	const physicsOutputs = [
		...new Set(
			physicsEnabled ? physicsGroups.flatMap((g) => g.outputs.filter((o) => o.weight !== 0).map((o) => o.id)) : [],
		),
	];
	const fingerprint = hashContent(
		files
			.map((f) => `${relative(directory, f.path)}:${f.hash}`)
			.sort()
			.join("\n"),
	);
	return {
		modelID,
		modelName: typeof config.Name === "string" ? config.Name : directory.split(/[\\/]/).at(-1)!,
		mappings,
		physicsOutputs,
		physicsGroups,
		sources,
		assetListing,
		fingerprint,
		directory,
		configFile: file,
		files,
		config,
		diagnostics,
	};
}

export async function profileFilesUnchanged(profile: ModelProfile): Promise<boolean> {
	if (!profile.files) return true;
	if (profile.directory && profile.assetListing) {
		const listing = (await readdir(profile.directory, { recursive: true }))
			.filter((f) => /\.(exp3|motion3|model3|physics3|cdi3)\.json$|\.moc3$|\.png$/i.test(f))
			.sort();
		if (JSON.stringify(listing) !== JSON.stringify(profile.assetListing)) return false;
	}
	for (const file of profile.files) {
		try {
			if (hashContent(await readFile(file.path)) !== file.hash) return false;
		} catch {
			return false;
		}
	}
	return true;
}
