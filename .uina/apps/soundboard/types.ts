export interface SoundItem {
  /** 唯一音效标识（如 "metal_pipe"） */
  readonly id: string;
  /** 音频文件名（如 "metal_pipe-钢管落地音效(很吵).wav"） */
  readonly filename: string;
  /** 音频文件绝对路径 */
  readonly filepath: string;
  /** 音效中文/人类可读名称（如 "钢管落地音效(很吵)"） */
  readonly name: string;
  /** 详细描述 */
  readonly description: string;
  /** 别名列表（用于搜索匹配） */
  readonly aliases: readonly string[];
  /** 响度微调（可选，例如 -30 表示衰减 30%） */
  readonly gainOffset?: number;
}

export interface SoundOverride {
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly gainOffset?: number;
}

export interface SoundboardConfig {
  readonly soundsDir?: string;
  readonly defaultVolume?: number;
  readonly mpvPath?: string;
  readonly soundOverrides?: Record<string, SoundOverride>;
}

export interface SoundboardState {
  readonly sounds: readonly SoundItem[];
  readonly lastPlayed: SoundItem | null;
  readonly volume: number;
}

export type MatchResult =
  | { readonly type: "match"; readonly sound: SoundItem }
  | { readonly type: "ambiguous"; readonly candidates: readonly SoundItem[] }
  | { readonly type: "none" };
