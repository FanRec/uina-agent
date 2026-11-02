/** Batch 8 through the existing formal Host/managed process and real Paper. */
process.argv.push("--library");
await import(new URL(import.meta.url.endsWith(".js") ? "./native-host.js" : "./native-host.ts", import.meta.url).href);

export {};
