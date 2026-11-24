import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { api, APP_VERSION, type UpdateInfo } from "../shared/api/api";

export type TvUpdatePhase = "connecting" | "downloading" | "verifying" | "ready";
export type TvUpdateProgress = {
  phase: TvUpdatePhase;
  source: string;
  attempt: number;
  totalAttempts: number;
  downloaded: number;
  total: number | null;
  percent: number | null;
};
export type TvUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type TvInstallerBridge = {
  canInstall?: () => boolean;
  hasCachedUpdate?: () => boolean;
  installCachedUpdate: () => string;
};

declare global {
  interface Window {
    HGhubXTvInstaller?: TvInstallerBridge;
  }
}

export type TvUpdaterSnapshot = {
  status: TvUpdateStatus;
  info: UpdateInfo | null;
  progress: TvUpdateProgress | null;
  downloadedUrl: string;
  downloadedSource: string;
  installerMessage: string;
  error: string;
};

let state: TvUpdaterSnapshot = {
  status: "idle",
  info: null,
  progress: null,
  downloadedUrl: "",
  downloadedSource: "",
  installerMessage: "",
  error: "",
};

let bootChecked = false;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
function emit(patch: Partial<TvUpdaterSnapshot>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function formatApkSize(bytes?: number | null): string {
  if (!bytes || !isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function summarizeReleaseNotes(notes?: string): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/^(?:[-*•]|\d+\.)\s+/, "").replace(/\*\*/g, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
}

const snap = () => state;

export async function checkTvUpdate(manual = true): Promise<void> {
  if (snap().status === "checking" || snap().status === "downloading") return;
  if (manual) {
    emit({ status: "checking", error: "", installerMessage: "" });
  }
  try {
    const info = await api.checkUpdate({ edition: "tv", currentVersion: APP_VERSION });
    if (snap().status === "downloading") return;
    const keepDownloaded =
      Boolean(info.has_update && info.asset?.url && snap().downloadedUrl === info.asset.url) &&
      window.HGhubXTvInstaller?.hasCachedUpdate?.() !== false;
    emit({
      info,
      status: keepDownloaded ? "downloaded" : info.has_update ? "available" : "up-to-date",
      error: "",
    });
  } catch (e) {
    if (!manual || snap().status === "downloading") return;
    const msg = e instanceof Error ? e.message : String(e);
    emit({
      status: snap().info?.has_update ? "available" : "error",
      error: msg,
    });
  }
}

export function bootCheckTvUpdate(): void {
  if (bootChecked) return;
  bootChecked = true;
  void checkTvUpdate(false);
}

export function installCachedTvUpdate(): string {
  const bridge = window.HGhubXTvInstaller;
  if (!bridge) {
    emit({
      installerMessage: "更新包已下载并通过 SHA-256 校验（当前非 Android TV 原生宿主，请在电视设备上完成安装）。",
      error: "",
    });
    return "unsupported";
  }
  let outcome = "failed";
  try {
    outcome = bridge.installCachedUpdate();
  } catch {
    outcome = "failed";
  }
  if (outcome === "launched") {
    emit({
      status: "downloaded",
      installerMessage: `已通过完整性校验（下载源：${state.downloadedSource || "GitHub"}），系统安装界面已拉起，请按遥控器确认覆盖安装。`,
      error: "",
    });
  } else if (outcome === "permission_requested") {
    emit({
      status: "downloaded",
      installerMessage: "请在系统设置中开启「允许安装未知应用」，按返回键回到本应用后会自动继续安装。",
      error: "",
    });
  } else if (outcome === "missing") {
    emit({
      status: state.info?.has_update ? "available" : "idle",
      downloadedUrl: "",
      downloadedSource: "",
      installerMessage: "",
      error: "缓存的更新包不存在或已被清理，请重新下载。",
    });
  } else {
    emit({
      status: "downloaded",
      installerMessage: "",
      error: "调起系统安装器失败，请检查电视「允许安装未知应用」权限后重试。",
    });
  }
  return outcome;
}

export async function downloadAndInstallTvUpdate(): Promise<void> {
  if (state.status === "downloading" || state.status === "checking") return;
  const asset = state.info?.asset;
  if (!state.info?.has_update || !asset?.url) {
    emit({ error: "当前新版本暂未提供适配本机架构的 APK 安装包。" });
    return;
  }
  emit({
    status: "downloading",
    error: "",
    installerMessage: "",
    progress: {
      phase: "connecting",
      source: "",
      attempt: 1,
      totalAttempts: 3,
      downloaded: 0,
      total: asset.size ?? null,
      percent: 0,
    },
  });
  const onProgress = new Channel<TvUpdateProgress>((progress) => {
    if (state.status === "downloading") {
      emit({ progress });
    }
  });
  try {
    const result = await invoke<{ ok: boolean; size: number; sha256: string; source: string }>(
      "download_tv_update",
      {
        url: asset.url,
        size: asset.size ?? null,
        sha256: asset.sha256 ?? null,
        onProgress,
      },
    );
    emit({
      status: "downloaded",
      progress: null,
      downloadedUrl: asset.url,
      downloadedSource: result.source || "github.com",
      error: "",
    });
    installCachedTvUpdate();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({
      status: state.info?.has_update ? "available" : "error",
      progress: null,
      error: msg,
    });
  }
}

export function cancelTvUpdateDownload(): void {
  void invoke("cancel_tv_update").catch(() => {});
  if (state.status === "downloading") {
    emit({
      status: state.info?.has_update ? "available" : "idle",
      progress: null,
      error: "下载已取消",
    });
  }
}

export function resetCachedTvUpdate(): void {
  if (state.downloadedUrl || state.status === "downloaded") {
    emit({
      downloadedUrl: "",
      downloadedSource: "",
      installerMessage: "",
      status: state.info?.has_update ? "available" : state.info ? "up-to-date" : "idle",
    });
  }
}

export const useTvUpdater = () => useSyncExternalStore(subscribe, () => state);
export const useTvHasUpdate = () => useSyncExternalStore(subscribe, () => Boolean(state.info?.has_update));
