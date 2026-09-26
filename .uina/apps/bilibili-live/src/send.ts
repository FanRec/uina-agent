import type { ActionOutcome } from "./types.js";

/**
 * 发送弹幕所需的凭据与网络配置
 */
export interface SendDanmakuOptions {
  roomId: number;
  message: string;
  sessdata: string;
  biliJct: string;
  buvid3?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface BilibiliSendResponse {
  code: number;
  message: string;
  msg?: string;
  data?: unknown;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 校验弹幕发送参数
 */
export function validateSendOptions(
  roomId: number,
  trimmedMsg: string,
  sessdata: string,
  biliJct: string
): string | null {
  if (!trimmedMsg) {
    return "发送失败：弹幕内容不能为空。";
  }
  if (trimmedMsg.length > 50) {
    return `发送失败：弹幕长度超过 50 个字符限制（当前 ${trimmedMsg.length} 字符）。`;
  }
  if (!sessdata || !biliJct) {
    return "发送失败：未配置有效的 SESSDATA 或 bili_jct。发送弹幕属于写操作，必须在 config.json 中配置用户凭据。";
  }
  if (!roomId || roomId <= 0) {
    return `发送失败：无效的直播间 ID (${roomId})。`;
  }
  return null;
}

/**
 * 处理发送弹幕的 HTTP 响应
 */
export async function handleSendHttpResponse(
  response: Response,
  trimmedMsg: string
): Promise<ActionOutcome<{ code?: number; message?: string }>> {
  if (!response.ok) {
    if (response.status >= 500) {
      return {
        status: "unknown",
        message: `B站服务端网关异常 (HTTP ${response.status})，弹幕是否送达未知。`,
      };
    }
    return {
      status: "failed",
      message: `HTTP 请求失败 (HTTP ${response.status}: ${response.statusText})。`,
    };
  }

  const data = (await response.json()) as BilibiliSendResponse;
  if (data.code === 0) {
    return {
      status: "succeeded",
      message: `弹幕发送成功: "${trimmedMsg}"`,
      data: { code: 0, message: "OK" },
    };
  }

  const errMsg = data.message || data.msg || "未知错误";
  return {
    status: "failed",
    message: `弹幕发送被拒绝 [code: ${data.code}]: ${errMsg}`,
    data: { code: data.code, message: errMsg },
  };
}

/**
 * 处理发送弹幕过程中的网络或超时异常
 */
export function handleSendError(
  error: unknown,
  timeoutMs: number
): ActionOutcome<{ code?: number; message?: string }> {
  const isAbort =
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"));

  return {
    status: "unknown",
    message: isAbort
      ? `发送弹幕请求超时 (${timeoutMs}ms)，弹幕是否送达未知。`
      : `网络连接异常，弹幕是否送达未知: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * 向指定B站直播间发送弹幕
 * 严格遵循三态结果模型（succeeded / failed / unknown）
 */
export async function sendDanmaku(
  options: SendDanmakuOptions
): Promise<ActionOutcome<{ code?: number; message?: string }>> {
  const {
    roomId,
    message,
    sessdata,
    biliJct,
    buvid3 = "",
    timeoutMs = 5000,
    fetchFn = fetch,
  } = options;

  const trimmedMsg = message.trim();
  const validationError = validateSendOptions(roomId, trimmedMsg, sessdata, biliJct);
  if (validationError) {
    return { status: "failed", message: validationError };
  }

  const bodyParams = new URLSearchParams({
    bubble: "0",
    msg: trimmedMsg,
    color: "16777215",
    mode: "1",
    fontsize: "25",
    rnd: Math.floor(Date.now() / 1000).toString(),
    roomid: roomId.toString(),
    csrf: biliJct,
    csrf_token: biliJct,
  });

  const cookieHeader = `SESSDATA=${sessdata}; bili_jct=${biliJct}${buvid3 ? `; buvid3=${buvid3}` : ""}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": DEFAULT_USER_AGENT,
    Referer: `https://live.bilibili.com/${roomId}`,
    Origin: "https://live.bilibili.com",
    Cookie: cookieHeader,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn("https://api.live.bilibili.com/msg/send", {
      method: "POST",
      headers,
      body: bodyParams.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await handleSendHttpResponse(response, trimmedMsg);
  } catch (error) {
    clearTimeout(timer);
    return handleSendError(error, timeoutMs);
  }
}
