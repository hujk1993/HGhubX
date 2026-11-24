//! Update check, TV package download, and external link opening commands.

use serde_json::Value;
use tauri_plugin_opener::OpenerExt;

/// 对比 GitHub Release 的 tag 与当前版本（支持标准版与 TV 独立版本通道）。
#[tauri::command]
pub async fn check_update(edition: Option<String>, current_version: Option<String>) -> Result<Value, String> {
    crate::updater::check_for_edition(edition.as_deref(), current_version.as_deref()).await
}

/// 下载并校验 Android TV 更新包（内置精简加速前缀自动回退 + SHA-256 校验）。
#[tauri::command]
pub async fn download_tv_update(app: tauri::AppHandle, url: String, size: Option<u64>, sha256: Option<String>, on_progress: tauri::ipc::Channel<Value>) -> Result<Value, String> {
    crate::updater::download_tv_update(&app, &url, size, sha256.as_deref(), on_progress).await
}

/// 取消正在进行的 Android TV 更新包下载。
#[tauri::command]
pub fn cancel_tv_update() {
    crate::updater::cancel_tv_update();
}

/// 用系统默认浏览器打开链接（只允许 http/https）。
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    // 固定使用默认处理器；不向前端暴露可指定程序的 opener 命令。
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}
