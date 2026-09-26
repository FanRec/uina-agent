import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TtsExtensionConfig {
  readonly serviceUrl: string;
  readonly pythonPath: string;
  readonly bridgeScript: string;
  readonly bridgeConfig: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly autoSpawn: boolean;
  readonly maxSentenceChars: number;
}

const DEFAULT_CONFIG: TtsExtensionConfig = {
  serviceUrl: "http://127.0.0.1:8102",
  pythonPath: "E:\\Uina\\ThirdParty\\gpt_sovits_v2pro\\runtime\\python.exe",
  bridgeScript: "bridge/main.py",
  bridgeConfig: "bridge/config/service.toml",
  startupTimeoutMs: 30000,
  requestTimeoutMs: 5000,
  autoSpawn: true,
  maxSentenceChars: 20,
};

export function getExtensionDir(): string {
  try {
    return resolve(fileURLToPath(new URL(".", import.meta.url)));
  } catch {
    return resolve(process.cwd(), ".uina/extensions/tts");
  }
}

export function loadConfig(
  customExtensionDir?: string,
  overrides?: Partial<TtsExtensionConfig>,
): TtsExtensionConfig {
  const extensionDir = customExtensionDir ? resolve(customExtensionDir) : getExtensionDir();
  const configPath = join(extensionDir, "config.json");

  let parsed: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Fallback to defaults on parse error
    }
  }

  const serviceUrl =
    process.env.UINA_TTS_SERVICE_URL ||
    (typeof overrides?.serviceUrl === "string" ? overrides.serviceUrl : undefined) ||
    (typeof parsed.serviceUrl === "string" ? parsed.serviceUrl : undefined) ||
    DEFAULT_CONFIG.serviceUrl;

  const pythonPath =
    process.env.UINA_TTS_PYTHON_PATH ||
    (typeof overrides?.pythonPath === "string" ? overrides.pythonPath : undefined) ||
    (typeof parsed.pythonPath === "string" ? parsed.pythonPath : undefined) ||
    DEFAULT_CONFIG.pythonPath;

  const bridgeScriptRaw =
    (typeof overrides?.bridgeScript === "string" ? overrides.bridgeScript : undefined) ||
    (typeof parsed.bridgeScript === "string" ? parsed.bridgeScript : undefined) ||
    DEFAULT_CONFIG.bridgeScript;
  const bridgeScript = resolve(extensionDir, bridgeScriptRaw);

  const bridgeConfigRaw =
    (typeof overrides?.bridgeConfig === "string" ? overrides.bridgeConfig : undefined) ||
    (typeof parsed.bridgeConfig === "string" ? parsed.bridgeConfig : undefined) ||
    DEFAULT_CONFIG.bridgeConfig;
  const bridgeConfig = resolve(extensionDir, bridgeConfigRaw);

  const startupTimeoutMs =
    (typeof overrides?.startupTimeoutMs === "number" ? overrides.startupTimeoutMs : undefined) ||
    (typeof parsed.startupTimeoutMs === "number" ? parsed.startupTimeoutMs : undefined) ||
    DEFAULT_CONFIG.startupTimeoutMs;

  const requestTimeoutMs =
    (typeof overrides?.requestTimeoutMs === "number" ? overrides.requestTimeoutMs : undefined) ||
    (typeof parsed.requestTimeoutMs === "number" ? parsed.requestTimeoutMs : undefined) ||
    DEFAULT_CONFIG.requestTimeoutMs;

  const autoSpawn =
    typeof overrides?.autoSpawn === "boolean"
      ? overrides.autoSpawn
      : typeof parsed.autoSpawn === "boolean"
        ? parsed.autoSpawn
        : DEFAULT_CONFIG.autoSpawn;

  const maxSentenceChars =
    (typeof overrides?.maxSentenceChars === "number" ? overrides.maxSentenceChars : undefined) ||
    (typeof parsed.maxSentenceChars === "number" ? parsed.maxSentenceChars : undefined) ||
    DEFAULT_CONFIG.maxSentenceChars;

  return {
    serviceUrl,
    pythonPath,
    bridgeScript,
    bridgeConfig,
    startupTimeoutMs,
    requestTimeoutMs,
    autoSpawn,
    maxSentenceChars,
  };
}
