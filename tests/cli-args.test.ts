import { describe, expect, it } from "vitest";
import { formatHelp, parseArgs, UINA_VERSION } from "../src/cli/args.js";
import { resolveSessionPath } from "../src/cli/session-path.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CLI Arguments Parser & Session Resolver", () => {
	it("parses empty arguments to default values", () => {
		const parsed = parseArgs([]);
		expect(parsed.prompt).toBeUndefined();
		expect(parsed.print).toBe(false);
		expect(parsed.model).toBeUndefined();
		expect(parsed.noSession).toBe(false);
		expect(parsed.help).toBe(false);
		expect(parsed.version).toBe(false);
		expect(parsed.rawPositionals).toEqual([]);
	});

	it("parses positional arguments into a combined prompt", () => {
		const parsed1 = parseArgs(["hello", "world"]);
		expect(parsed1.prompt).toBe("hello world");
		expect(parsed1.rawPositionals).toEqual(["hello", "world"]);

		const parsed2 = parseArgs(["\"multiple", "words", "in", "quotes\""]);
		expect(parsed2.prompt).toBe("\"multiple words in quotes\"");
	});

	it("parses print flags (-p, --print)", () => {
		expect(parseArgs(["-p"]).print).toBe(true);
		expect(parseArgs(["--print"]).print).toBe(true);
		expect(parseArgs(["-p", "run this"]).prompt).toBe("run this");
		expect(parseArgs(["-p", "run this"]).print).toBe(true);
	});

	it("parses model flags (-m, --model, -m=, --model=)", () => {
		expect(parseArgs(["-m", "deepseek-r1"]).model).toBe("deepseek-r1");
		expect(parseArgs(["--model", "openai/gpt-4o"]).model).toBe("openai/gpt-4o");
		expect(parseArgs(["-m=qwen-turbo"]).model).toBe("qwen-turbo");
		expect(parseArgs(["--model=anthropic/claude-3-5-sonnet"]).model).toBe("anthropic/claude-3-5-sonnet");
	});

	it("parses --no-session flag", () => {
		expect(parseArgs(["--no-session"]).noSession).toBe(true);
		expect(parseArgs(["--no-session", "test prompt"]).prompt).toBe("test prompt");
	});

	it("parses help and version flags", () => {
		expect(parseArgs(["-h"]).help).toBe(true);
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-v"]).version).toBe(true);
		expect(parseArgs(["--version"]).version).toBe(true);
	});

	it("handles -- delimiter so following flags become positional arguments", () => {
		const parsed = parseArgs(["--model", "gpt-4o", "--", "-p", "--help", "actual text"]);
		expect(parsed.model).toBe("gpt-4o");
		expect(parsed.print).toBe(false);
		expect(parsed.help).toBe(false);
		expect(parsed.prompt).toBe("-p --help actual text");
		expect(parsed.rawPositionals).toEqual(["-p", "--help", "actual text"]);
	});

	it("formatHelp returns concise and formatted CLI manual", () => {
		const help = formatHelp();
		expect(help).toContain(`v${UINA_VERSION}`);
		expect(help).toContain("uina [选项] [prompt...]");
		expect(help).toContain("-p, --print");
		expect(help).toContain("-m, --model");
		expect(help).toContain("--no-session");
	});

	describe("resolveSessionPath", () => {
		it("returns undefined when noSession is true", () => {
			expect(resolveSessionPath({ noSession: true })).toBeUndefined();
		});

		it("prefers explicit UINA_SESSION_PATH env variable if provided", () => {
			const prev = process.env.UINA_SESSION_PATH;
			try {
				process.env.UINA_SESSION_PATH = "custom/session.jsonl";
				expect(resolveSessionPath()).toBe("custom/session.jsonl");
			} finally {
				if (prev !== undefined) process.env.UINA_SESSION_PATH = prev;
				else delete process.env.UINA_SESSION_PATH;
			}
		});

		it("preserves data/session.jsonl if it already exists in the workspace", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "uina-test-local-"));
			try {
				mkdirSync(join(tempDir, "data"), { recursive: true });
				writeFileSync(join(tempDir, "data", "session.jsonl"), "");
				const resolved = resolveSessionPath({ cwd: tempDir });
				expect(resolved).toBe(join(tempDir, "data", "session.jsonl"));
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("resolves to global unified session path ~/.uina/session.jsonl for external workspaces", () => {
			const tempHome = mkdtempSync(join(tmpdir(), "uina-test-home-"));
			const extDir = mkdtempSync(join(tmpdir(), "uina-test-ext-project-"));
			const prevHome = process.env.UINA_HOME;
			const prevSessionPath = process.env.UINA_SESSION_PATH;
			try {
				delete process.env.UINA_SESSION_PATH;
				process.env.UINA_HOME = tempHome;
				const resolved = resolveSessionPath({ cwd: extDir });
				expect(resolved).toBe(join(tempHome, ".uina", "session.jsonl"));
			} finally {
				if (prevHome !== undefined) process.env.UINA_HOME = prevHome;
				else delete process.env.UINA_HOME;
				if (prevSessionPath !== undefined) process.env.UINA_SESSION_PATH = prevSessionPath;
				else delete process.env.UINA_SESSION_PATH;
				rmSync(tempHome, { recursive: true, force: true });
				rmSync(extDir, { recursive: true, force: true });
			}
		});
	});
});
