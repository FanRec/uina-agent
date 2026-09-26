import { createHash } from "node:crypto";

export const WBI_KEY_INDEX_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

let cachedWbiKey: { img_key: string; sub_key: string; expireAt: number } | null = null;

/**
 * 清除 WBI 缓存（例如遭遇 -352 签名风控错误时）
 */
export function invalidateWbiCache(): void {
  cachedWbiKey = null;
}

/**
 * 按照 32 位置换表混淆计算 WBI 秘钥
 */
export function calculateWbiKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return WBI_KEY_INDEX_TABLE.map((i) => raw[i] || "").join("");
}

/**
 * 为请求参数进行 WBI 签名
 * 1. 追加当前时间戳 wts（支持外部固定时间戳以支持可重现测试）
 * 2. 过滤 !'()* 字符
 * 3. 按照 Key 字典升序排列
 * 4. 计算 MD5(query + wbiKey) 得到 w_rid
 */
export function signWbiParams(
  params: Record<string, any>,
  wbiKey: string,
  customWts?: string
): Record<string, string> {
  const wts = customWts || String(params.wts ?? Math.floor(Date.now() / 1000));
  const rawEntries: Record<string, string> = {};

  for (const [k, v] of Object.entries(params)) {
    if (k !== "wts") {
      rawEntries[k] = String(v ?? "").replace(/[!'()*]/g, "");
    }
  }
  rawEntries.wts = wts;

  const sortedKeys = Object.keys(rawEntries).sort();
  const searchParams = new URLSearchParams();

  for (const key of sortedKeys) {
    searchParams.set(key, rawEntries[key]!);
  }

  const query = searchParams.toString();
  const w_rid = createHash("md5").update(query + wbiKey).digest("hex");

  return {
    ...rawEntries,
    w_rid,
  };
}

/**
 * 从图片 URL 路径中提取 key
 */
export function extractKeyFromUrl(url: string): string {
  return url.split("/").pop()?.split(".")[0] || "";
}

/**
 * 从 B 站接口获取最新的 WBI img_key 与 sub_key（支持 TTL 缓存）
 */
export async function getWbiKeys(
  sessdata?: string
): Promise<{ img_key: string; sub_key: string }> {
  const now = Date.now();
  if (cachedWbiKey && cachedWbiKey.expireAt > now && !sessdata) {
    return { img_key: cachedWbiKey.img_key, sub_key: cachedWbiKey.sub_key };
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
  };
  if (sessdata) {
    headers["Cookie"] = `SESSDATA=${sessdata}`;
  }

  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers,
  });

  if (!res.ok) {
    throw new Error(`getWbiKeys failed: HTTP status ${res.status}`);
  }

  const json = (await res.json()) as any;
  const wbiImg = json?.data?.wbi_img;

  if (!wbiImg?.img_url || !wbiImg?.sub_url) {
    throw new Error(`getWbiKeys failed: invalid response data`);
  }

  const img_key = extractKeyFromUrl(wbiImg.img_url);
  const sub_key = extractKeyFromUrl(wbiImg.sub_url);

  if (!sessdata) {
    cachedWbiKey = {
      img_key,
      sub_key,
      expireAt: now + 6 * 3600 * 1000, // 缓存 6 小时
    };
  }

  return { img_key, sub_key };
}
