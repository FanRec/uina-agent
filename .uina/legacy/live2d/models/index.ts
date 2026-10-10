import { readFile } from "node:fs/promises";
import type { ModelProfile } from "../model-profile.js";
import type { ModelRig } from "../model-adapter.js";
import type { ModelPackage, VisualAcceptance } from "../model-package.js";
import { moPackage } from "./mo/index.js";
import { hiyoriPackage } from "./hiyori/index.js";
const packages:Readonly<Record<string,{folder:string;create:(rig:ModelRig,acceptance?:VisualAcceptance)=>ModelPackage}>>={
  da0021cd32ee464ca41f980e8c32515b:{folder:"mo",create:moPackage},
  d0428c3ba32b4399ad51b6987616c48e:{folder:"hiyori",create:hiyoriPackage},
};
export async function loadModelPackage(profile:ModelProfile):Promise<ModelPackage|undefined> {
  const entry=packages[profile.modelID];if(!entry)return;
  const rig:ModelRig=JSON.parse(await readFile(new URL(`./${entry.folder}/rig.json`,import.meta.url),"utf8"));
  let acceptance:VisualAcceptance|undefined;
  try {acceptance=JSON.parse(await readFile(new URL(`./${entry.folder}/acceptance.json`,import.meta.url),"utf8"));}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return entry.create(rig,acceptance);
}
