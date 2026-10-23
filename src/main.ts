#!/usr/bin/env node
import { errorMessage } from "./core/errors.js";
import { runApp } from "./cli/app.js";

void runApp(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`[启动失败] ${errorMessage(error)}\n`);
	process.exitCode = 1;
});
