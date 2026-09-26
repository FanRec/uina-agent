import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LiveAppConfig,
  ViewportConfig,
  FilteringConfig,
  GiftsConfig,
  NetworkConfig,
  StorageConfig,
  WakeupConfig,
} from "./types.js";

/**
 * 完整解析后的应用配置（所有字段均有保证的确定值）
 */
export interface ResolvedLiveAppConfig {
  defaultRoomId: number;
  sessdata: string;
  biliJct: string;
  buvid3: string;
  openPlatform?: {
    accessKeyId: string;
    accessKeySecret: string;
    appId: number;
    code: string;
  };
  viewport: ViewportConfig;
  filtering: FilteringConfig;
  gifts: GiftsConfig;
  network: NetworkConfig;
  storage: StorageConfig;
  wakeup: WakeupConfig;
}

export const DEFAULT_VIEWPORT_CONFIG: ViewportConfig = {
  approximateBudgetTokens: 200,
  maxViewportChars: 600,
  maxItems: 20,
  minResidenceMs: 10000,
  showTimestamps: true,
  aggregationWindowMs: 20000,
};

export const DEFAULT_FILTERING_CONFIG: FilteringConfig = {
  filterKeywords: [], // 默认空列表，保持主体注意力中立
  ignoreEmojiOnly: false,
  maxDanmakuLength: 50,
};

export const DEFAULT_GIFTS_CONFIG: GiftsConfig = {
  pendingThreshold: 1000,
  aggregationWindowMs: 10000,
};

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  autoReconnect: true,
  requestTimeoutMs: 5000,
  maxReconnectDelayMs: 30000,
};

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  dataDir: "./data",
  journalCompactionThreshold: 500,
};

export const DEFAULT_WAKEUP_CONFIG: WakeupConfig = {
  wakeOnSuperChat: true,
  superChatMinPrice: 0,
  wakeOnGuard: true,
  wakeOnGiftThreshold: 1000,
};

/**
 * 解析认证凭据与房间 ID
 */
export function resolveAuthCredentials(
  customConfig?: Partial<LiveAppConfig>,
  fileConfig: Partial<LiveAppConfig> = {}
): { defaultRoomId: number; sessdata: string; biliJct: string; buvid3: string } {
  const envRoomId = process.env.BILI_ROOM_ID ? parseInt(process.env.BILI_ROOM_ID, 10) : undefined;
  const defaultRoomId =
    customConfig?.defaultRoomId ||
    fileConfig.defaultRoomId ||
    (envRoomId && !Number.isNaN(envRoomId) ? envRoomId : 6);

  const sessdata =
    (customConfig?.sessdata?.trim() ||
      fileConfig.sessdata?.trim() ||
      process.env.BILI_SESSDATA?.trim()) ??
    "";

  const biliJct =
    (customConfig?.biliJct?.trim() ||
      fileConfig.biliJct?.trim() ||
      process.env.BILI_JCT?.trim()) ??
    "";

  const buvid3 =
    (customConfig?.buvid3?.trim() ||
      fileConfig.buvid3?.trim() ||
      process.env.BILI_BUVID3?.trim()) ??
    "";

  return { defaultRoomId, sessdata, biliJct, buvid3 };
}

/**
 * 解析视口配置
 */
export function resolveViewportConfig(
  customConfig?: Partial<LiveAppConfig>,
  fileConfig: Partial<LiveAppConfig> = {}
): ViewportConfig {
  const rawViewport = {
    ...DEFAULT_VIEWPORT_CONFIG,
    ...(fileConfig.viewport ?? {}),
    ...(customConfig?.viewport ?? {}),
  } as ViewportConfig & { maxBudgetTokens?: number };

  return {
    approximateBudgetTokens:
      rawViewport.approximateBudgetTokens ?? rawViewport.maxBudgetTokens ?? 200,
    maxViewportChars: rawViewport.maxViewportChars ?? 600,
    maxItems: rawViewport.maxItems ?? 20,
    minResidenceMs: rawViewport.minResidenceMs ?? 10000,
    showTimestamps: rawViewport.showTimestamps ?? true,
    aggregationWindowMs: rawViewport.aggregationWindowMs ?? 20000,
  };
}

/**
 * 加载并深度合并配置
 * 优先级：显式入参 > config.json（非空） > 环境变量 > 默认值
 */
export function loadConfig(
  customConfig?: Partial<LiveAppConfig>,
  customAppDir?: string
): ResolvedLiveAppConfig {
  const currentFileDir = dirname(fileURLToPath(import.meta.url));
  const appRootDir = customAppDir ?? resolve(currentFileDir, "..");
  const configPath = join(appRootDir, "config.json");

  let fileConfig: Partial<LiveAppConfig> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw) as Partial<LiveAppConfig>;
    } catch {
      // 容错回退
    }
  }

  const { defaultRoomId, sessdata, biliJct, buvid3 } = resolveAuthCredentials(
    customConfig,
    fileConfig
  );

  const openPlatform = customConfig?.openPlatform ?? fileConfig.openPlatform;
  const viewport = resolveViewportConfig(customConfig, fileConfig);

  const filtering: FilteringConfig = {
    ...DEFAULT_FILTERING_CONFIG,
    ...(fileConfig.filtering ?? {}),
    ...(customConfig?.filtering ?? {}),
  };

  const gifts: GiftsConfig = {
    ...DEFAULT_GIFTS_CONFIG,
    ...(fileConfig.gifts ?? {}),
    ...(customConfig?.gifts ?? {}),
  };

  const network: NetworkConfig = {
    ...DEFAULT_NETWORK_CONFIG,
    ...(fileConfig.network ?? {}),
    ...(customConfig?.network ?? {}),
  };

  const rawStorage = {
    ...DEFAULT_STORAGE_CONFIG,
    ...(fileConfig.storage ?? {}),
    ...(customConfig?.storage ?? {}),
  };

  const storage: StorageConfig = {
    ...rawStorage,
    dataDir: resolve(appRootDir, rawStorage.dataDir),
  };

  const wakeup: WakeupConfig = {
    ...DEFAULT_WAKEUP_CONFIG,
    ...(fileConfig.wakeup ?? {}),
    ...(customConfig?.wakeup ?? {}),
  };

  return {
    defaultRoomId,
    sessdata,
    biliJct,
    buvid3,
    openPlatform,
    viewport,
    filtering,
    gifts,
    network,
    storage,
    wakeup,
  };
}
