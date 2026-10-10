import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { hashContent, modelFilePath, profileFilesUnchanged, type ModelProfile } from "./model-profile.js";
import { compileModelAdapter, type ModelRig } from "./model-adapter.js";
export interface FilePatch { path: string; beforeHash: string; afterHash: string; content: string; }
export interface PreparationPlan { version: 1; modelID: string; directory: string; facts: ModelProfile; patches: readonly FilePatch[]; }
/** Prepare only explicitly authored active bindings. Preserve follower rows and every physics file. */
export async function planModelPreparation(profile:ModelProfile,rig:ModelRig):Promise<PreparationPlan> {
 if(!profile.directory||!profile.configFile||!profile.config||rig.modelID!==profile.modelID)throw new Error("准备需要匹配的真实事实与手工 rig");
 const config=structuredClone(profile.config) as {ModelID:string;ParameterSettings:Record<string,unknown>[]};
 if(!Array.isArray(config.ParameterSettings)||config.ModelID!==profile.modelID)throw new Error("配置结构或身份不匹配");
 for(const targets of Object.values(rig.bindings))for(const t of targets){
   const rows=config.ParameterSettings.filter(r=>r.OutputLive2D===t.parameter), row=rows.find(r=>r.Input===t.input);
   if(!row)throw new Error(`手工选择的绑定不存在: ${t.parameter} → ${t.input}`);
   const range=profile.parameterRanges?.[t.parameter];if(!range)throw new Error(`真实范围未核验: ${t.parameter}`);
   config.ParameterSettings=config.ParameterSettings.filter(r=>r.OutputLive2D!==t.parameter);
   config.ParameterSettings.push({...row,UseBlinking:false,UseBreathing:false,Smoothing:t.smoothing,ClampInput:true,ClampOutput:true,
     OutputRangeLower:Math.max(range.min,Math.min(range.max,Number(row.OutputRangeLower))),OutputRangeUpper:Math.max(range.min,Math.min(range.max,Number(row.OutputRangeUpper)))});
 }
 // A pure compile against the planned facts validates all curves and accepted fanout before a write.
 const mappings=config.ParameterSettings.map((r,index)=>({input:String(r.Input),output:String(r.OutputLive2D),inputMin:Number(r.InputRangeLower),inputMax:Number(r.InputRangeUpper),outputMin:Number(r.OutputRangeLower),outputMax:Number(r.OutputRangeUpper),useBreathing:r.UseBreathing===true,useBlinking:r.UseBlinking===true,smoothing:Number(r.Smoothing),index}));
 compileModelAdapter({...profile,mappings},rig);
 const path=await modelFilePath(profile.directory,profile.configFile), original=await readFile(path);
 const expected=profile.files?.find(f=>resolve(f.path)===resolve(path));if(!expected||expected.hash!==hashContent(original))throw new Error("准备快照已失效");
 const content=JSON.stringify(config,null,2)+"\n";
 return {version:1,modelID:profile.modelID,directory:profile.directory,facts:profile,patches:[{path,beforeHash:hashContent(original),afterHash:hashContent(content),content}]};
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
