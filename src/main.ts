#!/usr/bin/env node
import { runApp } from "./cli/app.js";

void runApp(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`[启动失败] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
