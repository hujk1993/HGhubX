import { useSyncExternalStore } from "react";
import { readStorage, STORAGE_KEYS } from "../storage/storage";

/**
 * 界面语言。源语言是简体中文：`tr("简体原文")` 以原文为键，简体不需要词典；
 * 繁体与英文词典在切换到对应语言时才按需加载（独立 chunk）。
 */
export type Locale = "zh-CN" | "zh-TW" | "en";

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 语言名始终使用各自的本语言写法，不参与翻译。 */
export const LOCALE_OPTIONS: readonly { id: Locale; label: string; htmlLang: string }[] = [
  { id: "zh-CN", label: "简体中文", htmlLang: "zh-CN" },
  { id: "zh-TW", label: "繁體中文", htmlLang: "zh-Hant" },
  { id: "en", label: "English", htmlLang: "en" },
];

type Dictionary = Record<string, string>;
type Param = string | number | boolean | null | undefined;

let current: Locale = DEFAULT_LOCALE;
let dictionary: Dictionary | null = null;
const listeners = new Set<() => void>();
const loaders: Record<Exclude<Locale, "zh-CN">, () => Promise<{ default: Dictionary }>> = {
  "zh-TW": () => import("./locales/zh-TW"),
  en: () => import("./locales/en"),
};

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "zh-TW" || value === "en";
}

/** 已保存的语言；没有保存过一律是简体中文（不跟随系统语言）。 */
export function readStoredLocale(): Locale {
  const saved = readStorage(STORAGE_KEYS.locale);
  return isLocale(saved) ? saved : DEFAULT_LOCALE;
}

function fill(text: string, params: Param[]): string {
  if (!params.length) return text;
  return text.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = params[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/** 翻译一条界面文案；`{0}`、`{1}` 是按顺序传入的参数。未收录的文案原样显示（简体）。 */
export function tr(source: string, ...params: Param[]): string {
  return fill(dictionary?.[source] ?? source, params);
}

/** 只标记、不翻译：用于模块级常量。使用处必须再用 `tr()` 显示，语言切换后才会更新。 */
export const N_ = <T extends string>(source: T): T => source;

export function getLocale(): Locale {
  return current;
}

function applyDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = LOCALE_OPTIONS.find(option => option.id === current)?.htmlLang ?? "zh-CN";
  document.title = tr(N_("HGhubX · 短剧"));
}

async function loadDictionary(locale: Locale): Promise<Dictionary | null> {
  if (locale === "zh-CN") return null;
  try {
    return (await loaders[locale]()).default;
  } catch {
    return null;
  }
}

/** 启动时调用：只加载词典并应用，不写存储；词典加载失败时退回简体。 */
export async function initLocale(locale: Locale = readStoredLocale()): Promise<void> {
  const loaded = await loadDictionary(locale);
  if (locale !== "zh-CN" && !loaded) { current = DEFAULT_LOCALE; dictionary = null; }
  else { current = locale; dictionary = loaded; }
  applyDocument();
  listeners.forEach(listener => listener());
}

/** 设置页切换语言：先加载词典，成功后才保存并通知界面重绘；失败时保持当前语言并抛出。 */
export async function setLocale(locale: Locale): Promise<void> {
  if (locale === current) return;
  const loaded = await loadDictionary(locale);
  if (locale !== "zh-CN" && !loaded) throw new Error("语言包加载失败");
  try { localStorage.setItem(STORAGE_KEYS.locale, locale); } catch { /* 本次生效，重启后恢复保存前的语言 */ }
  current = locale;
  dictionary = loaded;
  applyDocument();
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}
