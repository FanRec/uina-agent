import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { AXES, AXIS_NAMES, type MotionAxis } from "./motion-axes.js";
import { calibrationPoints, type ModelAdapterDefinition } from "./model-adapter.js";
import { hashContent, modelFilePath, profileFilesUnchanged, type ModelProfile } from "./model-profile.js";

interface InputPreparation {
	name: string;
	min: number;
	max: number;
	defaultValue: number;
}
interface FilePatch {
	path: string;
	beforeHash: string;
	afterHash: string;
	content: string;
}
export interface PreparationPlan {
	version: 1;
	modelID: string;
	directory: string;
	facts: ModelProfile;
	definition: ModelAdapterDefinition;
	inputs: readonly InputPreparation[];
	patches: readonly FilePatch[];
	diagnostics: readonly string[];
	manualBindings: readonly {
		axis: MotionAxis;
		input: string;
		parameter: string;
		inputRange: readonly number[];
		outputRange: readonly number[];
	}[];
}
const inputName = (axis: MotionAxis): string =>
	"Uina" +
	axis
		.split(".")
		.map((s) => s[0]!.toUpperCase() + s.slice(1))
		.join("");

/** Pure preparation policy. Disk changes and global input creation are separate operations. */
export async function planModelPreparation(
	profile: ModelProfile,
	definition: ModelAdapterDefinition,
): Promise<PreparationPlan> {
	if (
		definition.version !== 1 ||
		(definition.modelID && definition.modelID !== profile.modelID) ||
		!profile.directory ||
		!profile.configFile ||
		!profile.config
	)
		throw new Error("准备需要匹配身份的完整磁盘快照");
	for (const axis of Object.keys(definition.axes))
		if (!Object.hasOwn(AXES, axis)) throw new Error(`未知动作轴: ${axis}`);
	const config = structuredClone(profile.config) as Record<string, any>;
	if (!Array.isArray(config.ParameterSettings) || !config.FileReferences?.Model || config.ModelID !== profile.modelID)
		throw new Error("不支持的 VTS 配置结构；请按手动绑定表准备");
	const requiredFields = [
		"Input",
		"OutputLive2D",
		"InputRangeLower",
		"InputRangeUpper",
		"OutputRangeLower",
		"OutputRangeUpper",
		"UseBreathing",
		"UseBlinking",
		"ClampInput",
		"ClampOutput",
		"Smoothing",
	];
	for (const row of config.ParameterSettings)
		if (!requiredFields.every((key) => Object.hasOwn(row, key))) throw new Error("VTS 绑定结构不匹配，拒绝猜测写入");
	const targets = new Set<string>();
	const inputs: InputPreparation[] = [];
	const manualBindings: PreparationPlan["manualBindings"][number][] = [];
	const prepared: ModelAdapterDefinition = { version: 1, modelID: profile.modelID, axes: {} };
	const diagnostics: string[] = [];
	for (const axis of AXIS_NAMES) {
		for (const target of definition.axes[axis] ?? []) {
			if (targets.has(target.parameter)) throw new Error(`多个轴写相同输出: ${target.parameter}`);
			targets.add(target.parameter);
			const range = profile.parameterRanges?.[target.parameter];
			if (
				!range ||
				![range.min, range.max, range.defaultValue].every(Number.isFinite) ||
				range.min >= range.max ||
				range.defaultValue < range.min ||
				range.defaultValue > range.max
			)
				throw new Error(`真实参数范围尚未核验: ${target.parameter}`);
			const points = calibrationPoints(axis, target, range);
			const name = inputName(axis);
			const metadata = AXES[axis];
			const p0 = points[0]!,
				pn = points.at(-1)!;
			const lo = p0[1],
				hi = pn[1];
			if (hi === lo) throw new Error(`校准输出为常量: ${target.parameter}`);
			// A normalized input shared by models remains neutral at zero.
			const neutralOutput = points.find((p) => p[0] === metadata.neutral)![1];
			const lower = (lo - neutralOutput) / Math.abs(hi - lo);
			const upper = (hi - neutralOutput) / Math.abs(hi - lo);
			const input = { name, min: -1, max: 1, defaultValue: 0 };
			if (!inputs.some((i) => i.name === name)) inputs.push(input);
			if (profile.sources?.some((s) => s.kind === "expression" && s.parameters.includes(target.parameter)))
				throw new Error(`${target.parameter}: 表情会写入目标，先准备不冲突的表情文件`);
			if (profile.sources?.some((s) => s.kind === "motion" && s.parameters.includes(target.parameter)))
				throw new Error(`${target.parameter}: 模型动画会写入目标，先处理相应动画/热键`);
			const existing = config.ParameterSettings.find((row: any) => row.OutputLive2D === target.parameter);
			if (!existing) throw new Error(`${target.parameter}: 缺少受支持的绑定模板，请先在 VTS 创建该输出的绑定`);
			const row = {
				...existing,
				Input: name,
				InputRangeLower: lower,
				InputRangeUpper: upper,
				OutputRangeLower: lo,
				OutputRangeUpper: hi,
				UseBreathing: false,
				UseBlinking: false,
				ClampInput: true,
				ClampOutput: true,
				Smoothing: 0,
			};
			config.ParameterSettings = config.ParameterSettings.filter((r: any) => r.OutputLive2D !== target.parameter);
			config.ParameterSettings.push(row);
			prepared.axes[axis] = [
				...(prepared.axes[axis] ?? []),
				{
					...target,
					input: name,
					allowFanout: false,
					points,
					provisional: target.provisional === true || !target.points,
				},
			];
			manualBindings.push({
				axis,
				input: name,
				parameter: target.parameter,
				inputRange: [lower, upper],
				outputRange: [lo, hi],
			});
		}
	}
	const patches: FilePatch[] = [];
	const patch = async (path: string, value: unknown) => {
		const original = await readFile(path, "utf8");
		const expected = profile.files?.find((f) => resolve(f.path) === resolve(path));
		if (!expected || expected.hash !== hashContent(original)) throw new Error(`快照后文件已变化: ${path}`);
		if (JSON.stringify(JSON.parse(original)) === JSON.stringify(value)) return;
		const content = JSON.stringify(value, null, 2) + "\n";
		patches.push({ path, beforeHash: hashContent(original), afterHash: hashContent(content), content });
	};
	const modelPath = await modelFilePath(profile.directory, config.FileReferences.Model);
	const model = JSON.parse(await readFile(modelPath, "utf8"));
	if (model.FileReferences?.Physics) {
		const physicsPath = await modelFilePath(
			profile.directory,
			join(relative(profile.directory, dirname(modelPath)), model.FileReferences.Physics),
		);
		const physics = JSON.parse(await readFile(physicsPath, "utf8"));
		if (
			physics.Version !== 3 ||
			!physics.Meta ||
			!Array.isArray(physics.PhysicsSettings) ||
			!Array.isArray(physics.Meta.PhysicsDictionary)
		)
			throw new Error("物理格式未识别，不能自动修改");
		const originalGroups = physics.PhysicsSettings.length;
		let removed = 0;
		for (const group of physics.PhysicsSettings) {
			if (!Array.isArray(group.Output) || !Array.isArray(group.Input) || !Array.isArray(group.Vertices))
				throw new Error("非法物理组");
			const before = group.Output.length;
			group.Output = group.Output.filter((o: any) => !targets.has(o.Destination?.Id));
			removed += before - group.Output.length;
		}
		if (removed) {
			physics.PhysicsSettings = physics.PhysicsSettings.filter((g: any) => g.Output.length);
			const ids = new Set(physics.PhysicsSettings.map((g: any) => g.Id));
			physics.Meta.PhysicsDictionary = physics.Meta.PhysicsDictionary.filter((d: any) => ids.has(d.Id));
			physics.Meta.PhysicsSettingCount = physics.PhysicsSettings.length;
			physics.Meta.TotalInputCount = physics.PhysicsSettings.reduce((n: number, g: any) => n + g.Input.length, 0);
			physics.Meta.TotalOutputCount = physics.PhysicsSettings.reduce((n: number, g: any) => n + g.Output.length, 0);
			physics.Meta.VertexCount = physics.PhysicsSettings.reduce((n: number, g: any) => n + g.Vertices.length, 0);
			diagnostics.push(`解除 ${removed} 个物理输出；物理组 ${originalGroups} → ${physics.PhysicsSettings.length}`);
			await patch(physicsPath, physics);
		}
	}
	await patch(await modelFilePath(profile.directory, profile.configFile), config);
	diagnostics.push("需先在 VTS 创建/核验输入，再关闭 VTS 应用补丁，重新加载后捕获并验证。未执行视觉验收。");
	return {
		version: 1,
		modelID: profile.modelID,
		directory: profile.directory,
		facts: profile,
		definition: prepared,
		inputs,
		patches,
		diagnostics,
		manualBindings,
	};
}

export async function assertVTSStopped(): Promise<void> {
	if (process.platform !== "win32") throw new Error("当前离线写入保护只支持 Windows；其他平台使用手动准备");
	const { stdout } = await promisify(execFile)(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"@(Get-Process -Name 'VTube Studio' -ErrorAction SilentlyContinue).Count",
		],
		{ windowsHide: true, timeout: 3000 },
	);
	if (stdout.trim() !== "0") throw new Error("请先关闭 VTube Studio，拒绝覆盖正在使用的配置");
}
interface RecoveryEntry {
	path: string;
	backup: string;
	beforeHash: string;
	afterHash: string;
}
interface RecoveryManifest {
	version: 1;
	directory: string;
	modelID: string;
	state: "prepared" | "applied" | "restored";
	entries: RecoveryEntry[];
}
async function containedFile(root: string, path: string): Promise<string> {
	const actual = await realpath(path),
		rel = relative(await realpath(root), actual);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`补丁目标越界: ${path}`);
	return actual;
}
async function replaceFile(path: string, bytes: string | Buffer): Promise<void> {
	const temporary = `${path}.uina-preparation-${process.pid}`;
	await writeFile(temporary, bytes, { flag: "wx" });
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** Complete backups are written before the first replacement. No implicit global input deletion. */
export async function applyPreparation(
	plan: PreparationPlan,
	recoveryDirectory: string,
	assertStopped = assertVTSStopped,
): Promise<string> {
	if (plan.version !== 1 || !plan.directory || !plan.modelID) throw new Error("非法准备计划");
	await assertStopped();
	const root = await realpath(plan.directory);
	if (!plan.facts || plan.facts.modelID !== plan.modelID || !(await profileFilesUnchanged(plan.facts)))
		throw new Error("补丁冲突：模型事实在计划后已变化");
	const paths = new Set<string>();
	for (const p of plan.patches) {
		const path = await containedFile(root, p.path);
		if (
			paths.has(path) ||
			!/\.(vtube|physics3)\.json$/i.test(path) ||
			hashContent(p.content) !== p.afterHash ||
			hashContent(await readFile(path)) !== p.beforeHash
		)
			throw new Error(`补丁冲突或非法目标: ${p.path}`);
		paths.add(path);
		const config = JSON.parse(p.content);
		if (path.endsWith(".vtube.json") && config.ModelID !== plan.modelID) throw new Error("配置身份不匹配");
	}
	await mkdir(recoveryDirectory, { recursive: false });
	const manifest: RecoveryManifest = {
		version: 1,
		directory: root,
		modelID: plan.modelID,
		state: "prepared",
		entries: [],
	};
	for (const [i, p] of plan.patches.entries()) {
		const backup = join(resolve(recoveryDirectory), `${i}.original`);
		const original = await readFile(p.path);
		if (hashContent(original) !== p.beforeHash) throw new Error(`备份期间文件变化: ${p.path}`);
		await writeFile(backup, original, { flag: "wx" });
		manifest.entries.push({ path: p.path, backup, beforeHash: p.beforeHash, afterHash: p.afterHash });
	}
	const manifestPath = join(recoveryDirectory, "recovery.json");
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
	try {
		for (const p of plan.patches) {
			await assertStopped();
			if (hashContent(await readFile(p.path)) !== p.beforeHash) throw new Error(`准备期间文件被修改: ${p.path}`);
			await replaceFile(p.path, p.content);
		}
		manifest.state = "applied";
		await replaceFile(manifestPath, JSON.stringify(manifest, null, 2));
	} catch (error) {
		try {
			await restorePreparation(manifestPath, assertStopped);
		} catch (restoreError) {
			throw new AggregateError([error, restoreError], `准备与恢复均失败，请使用 ${manifestPath}`);
		}
		throw error;
	}
	return manifestPath;
}

export async function restorePreparation(manifestPath: string, assertStopped = assertVTSStopped): Promise<void> {
	await assertStopped();
	const manifest: RecoveryManifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("非法恢复清单");
	for (const entry of manifest.entries) {
		await containedFile(manifest.directory, entry.path);
		await containedFile(dirname(manifestPath), entry.backup);
		const hash = hashContent(await readFile(entry.path));
		if (hash !== entry.beforeHash && hash !== entry.afterHash) throw new Error(`恢复拒绝覆盖后续修改: ${entry.path}`);
		if (hashContent(await readFile(entry.backup)) !== entry.beforeHash) throw new Error(`备份损坏: ${entry.backup}`);
	}
	for (const entry of manifest.entries) {
		await assertStopped();
		const hash = hashContent(await readFile(entry.path));
		if (hash !== entry.beforeHash && hash !== entry.afterHash) throw new Error(`恢复期间文件变化: ${entry.path}`);
		if (hash !== entry.beforeHash) await replaceFile(entry.path, await readFile(entry.backup));
	}
	manifest.state = "restored";
	await replaceFile(manifestPath, JSON.stringify(manifest, null, 2));
}
