/**
 * 查询声明与读取方式的配对（组合根据此装配 World 读取表与目录）。
 *
 * reader 省略表示"由 World 自己的存储实现"（events@1）：
 * 声明仍在能力面一处，避免目录与实现分散到两套清单。
 */

import type { QueryDescriptor, QueryReader } from "../../contracts/capabilities.js";

export interface QuerySpec {
	descriptor: QueryDescriptor;
	reader?: QueryReader;
}
