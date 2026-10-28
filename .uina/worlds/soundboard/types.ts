/**
 * 一个可播放的音效。
 *
 * 名称与别名只有两个来源：文件名，以及 config.json 的 soundOverrides。
 * 没有索引文件，因此不存在"目录和索引不一致"这种状态。
 */
export interface SoundItem {
	/** 唯一标识，取自文件名第一个 `-` 之前的部分（小写）。 */
	readonly id: string;
	/** 音频文件名。 */
	readonly filename: string;
	/** 音频文件绝对路径。 */
	readonly filepath: string;
	/** 人类可读名称：文件名第一个 `-` 之后的部分，可被 config.json 覆盖。 */
	readonly name: string;
	/** 匹配词表：id、名称、文件名原始尾巴、config.json 里的额外别名（去重）。 */
	readonly aliases: readonly string[];
	/** 音量偏移，0–100 音量刻度上的加减（不是 dB，也不是百分比）。 */
	readonly volumeOffset?: number;
}

/** config.json 里对单个音效的覆盖。 */
export interface SoundOverride {
	readonly name?: string;
	readonly aliases?: readonly string[];
	readonly volumeOffset?: number;
}

/** 解析完成后的世界配置：除 mpvPath 外全部有值。 */
export interface SoundboardConfig {
	readonly soundsDir: string;
	readonly defaultVolume: number;
	readonly mpvPath?: string;
	readonly soundOverrides: Record<string, SoundOverride>;
}

/** 四级确定性匹配的结果。 */
export type MatchResult =
	| { readonly type: "match"; readonly sound: SoundItem }
	| { readonly type: "ambiguous"; readonly candidates: readonly SoundItem[] }
	| { readonly type: "none" };
