import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileItem } from "../src/ui/components/editor/file-candidates.js";

const searchFileCandidatesMock = vi.hoisted(() =>
	vi.fn<(cwd: string, query: string, topK: number) => Promise<FileItem[]>>(),
);

vi.mock("../src/ui/components/editor/file-candidates.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/ui/components/editor/file-candidates.js")>()),
	searchFileCandidates: searchFileCandidatesMock,
}));

import { createTestTUI, dispatchUIHostInput } from "./harness/index.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function nextFrame(): Promise<void> {
	return Promise.resolve().then(() => new Promise((resolve) => setImmediate(resolve)));
}

describe("file suggestion async lifecycle", () => {
	afterEach(() => {
		searchFileCandidatesMock.mockReset();
	});

	it("shows loading, keeps accepting input, and ignores an older query result", async () => {
		const first = deferred<FileItem[]>();
		const second = deferred<FileItem[]>();
		searchFileCandidatesMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		try {
			dispatchUIHostInput(harness.host, "@");
			expect(searchFileCandidatesMock).toHaveBeenNthCalledWith(1, expect.any(String), "", 40);
			await nextFrame();
			expect(harness.visibleText).toContain("扫描中");

			dispatchUIHostInput(harness.host, "u");
			expect(harness.inputText).toBe("@u");
			expect(searchFileCandidatesMock).toHaveBeenNthCalledWith(2, expect.any(String), "u", 40);

			first.resolve([{ path: "old-result.ts", name: "old-result.ts", kind: "file" }]);
			await nextFrame();
			expect(harness.visibleText).toContain("扫描中");
			expect(harness.visibleText).not.toContain("old-result.ts");

			second.resolve([{ path: "ui.ts", name: "ui.ts", kind: "file" }]);
			await nextFrame();
			expect(harness.visibleText).toContain("ui.ts");
		} finally {
			harness.dispose();
		}
	});

	it("clears a pending card when a programmatic draft replaces its query", async () => {
		const pending = deferred<FileItem[]>();
		searchFileCandidatesMock.mockReturnValueOnce(pending.promise);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		try {
			dispatchUIHostInput(harness.host, "@stale");
			await nextFrame();
			expect(harness.visibleText).toContain("扫描中");

			harness.host.replaceInput("new draft");
			pending.resolve([{ path: "stale.ts", name: "stale.ts", kind: "file" }]);
			await nextFrame();

			expect(harness.visibleText).toContain("new draft");
			expect(harness.visibleText).not.toContain("扫描中");
			expect(harness.visibleText).not.toContain("stale.ts");
		} finally {
			harness.dispose();
		}
	});

	it("does not insert a literal Tab while file candidates are loading", async () => {
		const pending = deferred<FileItem[]>();
		searchFileCandidatesMock.mockReturnValueOnce(pending.promise);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		try {
			dispatchUIHostInput(harness.host, "@u");
			await nextFrame();
			expect(harness.visibleText).toContain("扫描中");

			dispatchUIHostInput(harness.host, "\t");

			expect(harness.inputText).toBe("@u");
			expect(harness.visibleText).toContain("扫描中");
		} finally {
			pending.resolve([]);
			harness.dispose();
		}
	});

	it("clears loaded suggestions when Ctrl+C clears the draft", async () => {
		searchFileCandidatesMock.mockResolvedValueOnce([{ path: "ui.ts", name: "ui.ts", kind: "file" }]);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		try {
			dispatchUIHostInput(harness.host, "@ui");
			await nextFrame();
			expect(harness.visibleText).toContain("ui.ts");

			dispatchUIHostInput(harness.host, "\x03");
			await nextFrame();

			expect(harness.inputText).toBe("");
			expect(harness.visibleText).not.toContain("ui.ts");
		} finally {
			harness.dispose();
		}
	});

	it("immediately invalidates a pending query when Ctrl+C clears the draft", async () => {
		const pending = deferred<FileItem[]>();
		searchFileCandidatesMock.mockReturnValueOnce(pending.promise);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		try {
			dispatchUIHostInput(harness.host, "@stale");
			await nextFrame();
			expect(harness.visibleText).toContain("扫描中");

			dispatchUIHostInput(harness.host, "\x03");
			await nextFrame();
			expect(harness.visibleText).not.toContain("扫描中");
			pending.resolve([{ path: "stale.ts", name: "stale.ts", kind: "file" }]);
			await nextFrame();

			expect(harness.visibleText).not.toContain("stale.ts");
		} finally {
			pending.resolve([]);
			harness.dispose();
		}
	});

	it("switches from a pending file query to an identical command query", async () => {
		const pending = deferred<FileItem[]>();
		searchFileCandidatesMock.mockReturnValueOnce(pending.promise);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		try {
			harness.host.registry.registerCommand({ name: "help", description: "Show help" });
			dispatchUIHostInput(harness.host, "@");
			dispatchUIHostInput(harness.host, "\x01");
			dispatchUIHostInput(harness.host, "/");
			expect(harness.inputText).toBe("/");
			await nextFrame();
			expect(harness.visibleText).toContain("help");
		} finally {
			pending.resolve([]);
			harness.dispose();
		}
	});

	it("does not let an invisible empty result consume Escape before busy-turn cancellation", async () => {
		searchFileCandidatesMock.mockResolvedValueOnce([]);
		const harness = createTestTUI({ columns: 90, rows: 24 });
		const cancel = vi.fn();
		harness.host.onCancel = cancel;
		harness.host.setBusy(true);
		try {
			dispatchUIHostInput(harness.host, "@missing");
			await nextFrame();
			dispatchUIHostInput(harness.host, "\x1b");
			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			harness.dispose();
		}
	});
});
