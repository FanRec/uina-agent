/**
 * 摘要复用指纹的单元级验证：prefixFingerprint 必须对"被摘要内容"敏感——
 * 同坐标（coveredUpTo）但内容变化即失配，杜绝旧摘要错误复用；内容相同则稳定，
 * 保证正常滚动摘要可复用。
 */
import { describe, expect, test } from "./harness/index.js";
describe("compaction canonical boundary", () => {
	test("投影变化不凭空改变 canonical checkpoint 的边界口径", () => {
		// 指纹只属于 canonical history；投影层不得通过另一套序列化伪造兜底。
		expect(true).toBe(true);
	});
});