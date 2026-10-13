import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../../../../src/extensions/world-framework/json-file.js";
import type { NotificationSetting, NotificationSettings } from "./types.js";

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  chat_messages: "off",
  room_status: "on",
  super_chats: "on",
  memberships: "on",
  gifts: "on",
};

function validSetting(value: unknown): value is NotificationSetting {
  return value === "on" || value === "off";
}

export function parseNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("通知设置必须是对象");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_NOTIFICATION_SETTINGS)) throw new Error(`未知通知设置: ${key}`);
  }
  for (const key of Object.keys(DEFAULT_NOTIFICATION_SETTINGS) as Array<keyof NotificationSettings>) {
    if (input[key] !== undefined && !validSetting(input[key])) throw new Error(`通知设置 ${key} 必须是 on 或 off`);
  }
  return {
    chat_messages: (input.chat_messages as NotificationSetting | undefined) ?? DEFAULT_NOTIFICATION_SETTINGS.chat_messages,
    room_status: (input.room_status as NotificationSetting | undefined) ?? DEFAULT_NOTIFICATION_SETTINGS.room_status,
    super_chats: (input.super_chats as NotificationSetting | undefined) ?? DEFAULT_NOTIFICATION_SETTINGS.super_chats,
    memberships: (input.memberships as NotificationSetting | undefined) ?? DEFAULT_NOTIFICATION_SETTINGS.memberships,
    gifts: (input.gifts as NotificationSetting | undefined) ?? DEFAULT_NOTIFICATION_SETTINGS.gifts,
  };
}

export async function loadNotificationSettings(path: string): Promise<NotificationSettings> {
  try {
    return parseNotificationSettings(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_NOTIFICATION_SETTINGS };
    throw error;
  }
}

export async function saveNotificationSettings(path: string, settings: NotificationSettings): Promise<void> {
  await writeJsonAtomic(path, settings);
}
