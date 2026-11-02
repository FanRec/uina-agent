/** Formal Host/WorldTool/managed Executor feedback acceptance; --model is one short calibration. */
process.argv.push("--feedback");
await import(new URL(import.meta.url.endsWith(".js") ? "./native-host.js" : "./native-host.ts", import.meta.url).href);

export {};
