import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tr } from "../i18n";

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error(tr("当前环境不支持复制，请在应用中重试"));
  }
  await navigator.clipboard.writeText(text);
}
