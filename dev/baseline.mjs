import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");
function run(command,args){return new Promise((resolvePromise,reject)=>{const ps=process.platform === "win32" ? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" : command; const psArgs=process.platform === "win32" ? ["-NoProfile","-Command", command+" "+args.map(a=>JSON.stringify(a)).join(" ")] : args; const child=spawn(ps,psArgs,{cwd:root,stdio:"inherit"});child.on("error",reject);child.on("exit",code=>code===0?resolvePromise():reject(new Error(command+" exited "+code)));});}
async function exists(path){try{await access(path);return true;}catch{return false;}}
console.log("[baseline] root="+root); await run("git",["status","--short"]); await run("git",["log","-1","--oneline"]);
for(const path of ["src/main.ts","src/host/host.ts","src/agent/loop.ts","src/ai","src/session","src/extensions","src/ui"]) console.log("[baseline] "+path+"="+(await exists(resolve(root,path))?"present":"missing"));
await run(process.platform === "win32" ? "C:/Users/34150/AppData/Roaming/npm/pnpm.cmd" : "pnpm",["check:boundaries"]); if(!quick){await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm",["typecheck"]);await run(process.platform === "win32" ? "C:/Users/34150/AppData/Roaming/npm/pnpm.cmd" : "pnpm",["test","--","--reporter=dot"]);await run(process.platform === "win32" ? "C:/Users/34150/AppData/Roaming/npm/pnpm.cmd" : "pnpm",["build"]);await run("git",["diff","--check"]);console.log("[baseline] native-assets="+(await exists(resolve(root,"dist/src/ui/core/native"))?"present":"missing"));} console.log("[baseline] complete");
