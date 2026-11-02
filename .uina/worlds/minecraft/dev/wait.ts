/** Batch 9A uses the same formal Host/managed process/Paper assembly. */
process.argv.push("--wait");
await import(new URL(import.meta.url.endsWith(".js") ? "./native-host.js" : "./native-host.ts", import.meta.url).href);

export {};
