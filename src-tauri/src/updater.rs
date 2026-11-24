//! GitHub Releases update check, TV APK multi-prefix download, and SHA-256 verification.

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

const REPO: &str = "zxsos/HGhubX";
const TV_APK_FILE: &str = "hghubx-tv-update.apk";
const TV_APK_PART: &str = "hghubx-tv-update.apk.part";
const MAX_APK_BYTES: u64 = 200 * 1024 * 1024;

/// 内置精简 GitHub Release 下载加速前缀（仅保留 2 个高可用节点 + 官方直连兜底）。
const TV_MIRROR_PREFIXES: &[&str] = &[
    "https://gh-proxy.com/",
    "https://ghfast.top/",
];

static DOWNLOAD_SEQ: AtomicU64 = AtomicU64::new(0);
static CANCEL_NOTIFY: Lazy<Notify> = Lazy::new(Notify::new);

fn ver_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|s| s.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 只比较数字段：`v1.2.0` > `1.1.9`；解析不出的段按 0 处理。
fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (ver_parts(latest), ver_parts(current));
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 从 tag / name 里取出 `x.y.z`。
///
/// 我们的 tag 是 `hgfix-1.2.1-r5`，上游是 `v1.2.0`，release name 是 `HGhubX 1.2.1+hg.1`。
/// 直接拿去比会从第一位就判负（`hgfix-1` 解析成 0），所以先抠出版本号。
fn version_in(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut dots = 0;
        let mut j = i;
        while j < chars.len() && (chars[j].is_ascii_digit() || (chars[j] == '.' && dots < 2)) {
            if chars[j] == '.' {
                dots += 1;
            }
            j += 1;
        }
        if dots == 2 {
            return chars[start..j].iter().collect();
        }
        i = j.max(i + 1);
    }
    String::new()
}

fn release_version(tag: &str) -> String {
    let found = version_in(tag);
    if found.is_empty() {
        tag.trim_start_matches("tv-")
            .trim_start_matches(['v', 'V'])
            .to_string()
    } else {
        found
    }
}

fn parse_sha256_digest(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let hex = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed)
        .trim();
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

async fn get_with_doh_fallback(
    url: &str,
    timeout: Duration,
    accept: Option<&str>,
) -> Result<reqwest::Response, String> {
    match crate::net::get_with_dns(url, timeout, accept, None, false).await {
        Ok(resp) => Ok(resp),
        Err(first_err) => {
            let can_fallback = url::Url::parse(url).ok().is_some_and(|target| {
                !crate::net::proxy_active(&target) && crate::media_dns::eligible(&target, &first_err)
            });
            if can_fallback {
                crate::net::get_with_dns(url, timeout, accept, None, true).await
            } else {
                Err(first_err)
            }
        }
    }
}

fn build_release_payload<F>(v: &Value, current: &str, rank: F) -> Value
where
    F: Fn(&str) -> u8,
{
    let tag = v
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let html = v
        .get("html_url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
    let notes = v.get("body").and_then(Value::as_str).unwrap_or("");
    let latest = release_version(&tag);
    let assets = v
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let asset = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(Value::as_str)?;
            let url = a.get("browser_download_url").and_then(Value::as_str)?;
            let score = rank(name);
            if score == 0 {
                return None;
            }
            let size = a.get("size").and_then(Value::as_u64);
            let sha256 = a
                .get("digest")
                .and_then(Value::as_str)
                .and_then(parse_sha256_digest);
            Some((score, name.to_string(), url.to_string(), size, sha256))
        })
        .max_by_key(|(score, _, _, _, _)| *score);
    let cmp_target = if tag.contains("+hg.") { &tag } else { &latest };
    json!({
        "current": current,
        "latest": latest,
        "tag": tag,
        "has_update": !latest.is_empty() && is_newer(cmp_target, current),
        "asset": asset.map(|(_, name, url, size, sha256)| json!({
            "name": name,
            "url": url,
            "size": size,
            "sha256": sha256,
        })),
        "url": html,
        "name": v.get("name").and_then(Value::as_str).unwrap_or(""),
        "published_at": v.get("published_at").and_then(Value::as_str).unwrap_or(""),
        "notes": notes.chars().take(800).collect::<String>(),
    })
}

/// 对比 GitHub Release 的 tag 与当前版本（未认证 60 次/小时/IP，够用）。
pub async fn check_for_edition(
    edition: Option<&str>,
    current_override: Option<&str>,
) -> Result<Value, String> {
    if edition == Some("tv") {
        return check_tv(current_override).await;
    }
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = get_with_doh_fallback(
        &url,
        Duration::from_secs(12),
        Some("application/vnd.github+json"),
    )
    .await?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }
    if !status.is_success() {
        return Err(format!("GitHub 返回 HTTP {status}"));
    }

    let v: Value = resp.json().await.map_err(|e| crate::net::err_text(&e))?;
    Ok(build_release_payload(&v, &current, asset_rank))
}

fn is_tv_release(v: &Value) -> bool {
    if v.get("draft").and_then(Value::as_bool).unwrap_or(false)
        || v.get("prerelease").and_then(Value::as_bool).unwrap_or(false)
    {
        return false;
    }
    let tag = v.get("tag_name").and_then(Value::as_str).unwrap_or("");
    if tag.starts_with("tv-v") {
        return true;
    }
    v.get("assets")
        .and_then(Value::as_array)
        .is_some_and(|assets| {
            assets.iter().any(|a| {
                a.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| {
                        let lower = n.to_ascii_lowercase();
                        lower.starts_with("hghubx-tv_") && lower.ends_with(".apk")
                    })
            })
        })
}

async fn check_tv(current_override: Option<&str>) -> Result<Value, String> {
    let default_ver = option_env!("HGHUBX_APP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    let current = current_override
        .map(version_in)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default_ver.to_string());
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=30");
    let resp = get_with_doh_fallback(
        &url,
        Duration::from_secs(12),
        Some("application/vnd.github+json"),
    )
    .await?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }
    if !status.is_success() {
        return Err(format!("GitHub 返回 HTTP {status}"));
    }

    let list: Vec<Value> = resp.json().await.map_err(|e| crate::net::err_text(&e))?;
    let mut best: Option<(String, Value)> = None;
    for item in list {
        if !is_tv_release(&item) {
            continue;
        }
        let ver = release_version(item.get("tag_name").and_then(Value::as_str).unwrap_or(""));
        if ver.is_empty() {
            continue;
        }
        if best.as_ref().is_none_or(|(best_ver, _)| is_newer(&ver, best_ver)) {
            best = Some((ver, item));
        }
    }
    let Some((_, chosen)) = best else {
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    };
    Ok(build_release_payload(&chosen, &current, tv_asset_rank))
}

/// 标准版安装包优先级，数字越大越优先。
///
/// 安卓的 release 里同时有 arm64 / arm(v7) / x86_64 三个 apk，光看「是不是 apk」
/// 会先撞上 armv7 那个，64 位机器就降到 32 位跑了。所以按架构给分，取最高。
fn asset_rank(name: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if cfg!(target_os = "android") {
        if !n.ends_with(".apk") || n.starts_with("hghubx-tv") {
            0
        } else if cfg!(target_arch = "aarch64") {
            if n.contains("arm64") || n.contains("aarch64") { 3 } else { 1 }
        } else if cfg!(target_arch = "x86_64") {
            if n.contains("x86_64") { 3 } else { 1 }
        } else if n.contains("x86") || n.contains("arm64") {
            1
        } else {
            2
        }
    } else if cfg!(target_os = "windows") {
        if n.ends_with(".exe") { 3 } else { 0 }
    } else if cfg!(target_os = "macos") {
        if n.ends_with(".dmg") { 3 } else { 0 }
    } else if cfg!(target_os = "ios") {
        if n.ends_with(".ipa") { 3 } else { 0 }
    } else if cfg!(target_os = "linux") && n.ends_with(".deb") {
        3
    } else if cfg!(target_os = "linux") && n.ends_with(".appimage") {
        2
    } else {
        0
    }
}

fn tv_asset_rank(name: &str) -> u8 {
    tv_asset_rank_for_arch(name, std::env::consts::ARCH)
}

fn tv_asset_rank_for_arch(name: &str, arch: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if !n.starts_with("hghubx-tv_") || !n.ends_with(".apk") {
        return 0;
    }
    let is_arm64 = n.contains("arm64") || n.contains("aarch64");
    let is_x86_64 = n.contains("x86_64");
    let is_x86 = !is_x86_64 && n.contains("x86");
    let is_universal = n.contains("universal");
    let is_arm32 = !is_arm64
        && !is_x86_64
        && !is_x86
        && !is_universal
        && (n.contains("_arm") || n.contains("armv7") || n.contains("armeabi"));
    match arch {
        "aarch64" => {
            if is_arm64 { 4 } else if is_universal { 3 } else if is_arm32 { 2 } else { 0 }
        }
        "arm" => {
            if is_arm32 { 4 } else if is_universal { 3 } else { 0 }
        }
        "x86_64" => {
            if is_x86_64 { 4 } else if is_universal { 3 } else { 0 }
        }
        _ => if is_universal { 3 } else { 1 },
    }
}

fn safe_release_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'))
}

fn validate_tv_apk_url(raw: &str) -> Result<url::Url, String> {
    let target = crate::network_policy::parse_target(raw)?;
    if target.scheme() != "https"
        || target.host_str() != Some("github.com")
        || target.port().is_some()
        || target.query().is_some()
        || target.fragment().is_some()
    {
        return Err("仅允许从官方 GitHub Release 下载 TV 更新包".into());
    }
    let segments: Vec<&str> = target
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    if segments.len() != 6
        || segments[0] != "zxsos"
        || segments[1] != "HGhubX"
        || segments[2] != "releases"
        || segments[3] != "download"
    {
        return Err("更新包地址不属于本仓库 Release 资产".into());
    }
    let (tag, filename) = (segments[4], segments[5]);
    let lower_file = filename.to_ascii_lowercase();
    if !safe_release_segment(tag)
        || !(tag.starts_with("tv-v") || tag.starts_with('v'))
        || !safe_release_segment(filename)
        || !lower_file.starts_with("hghubx-tv_")
        || !lower_file.ends_with(".apk")
    {
        return Err("更新包文件名或版本标签不受信任".into());
    }
    Ok(target)
}

fn download_candidates(canonical: &url::Url) -> Vec<(String, String)> {
    let direct = ("github.com".to_string(), canonical.as_str().to_string());
    let mirrors: Vec<(String, String)> = TV_MIRROR_PREFIXES
        .iter()
        .filter_map(|prefix| {
            let host = url::Url::parse(prefix).ok()?.host_str()?.to_string();
            Some((host, format!("{prefix}{}", canonical.as_str())))
        })
        .collect();
    let mut out = Vec::with_capacity(mirrors.len() + 1);
    if crate::net::proxy_active(canonical) {
        out.push(direct);
        out.extend(mirrors);
    } else {
        out.extend(mirrors);
        out.push(direct);
    }
    out
}

fn ensure_active(seq: u64) -> Result<(), String> {
    if DOWNLOAD_SEQ.load(Ordering::Acquire) == seq {
        Ok(())
    } else {
        Err("下载已取消".into())
    }
}

pub fn cancel_tv_update() {
    DOWNLOAD_SEQ.fetch_add(1, Ordering::AcqRel);
    CANCEL_NOTIFY.notify_waiters();
}

pub fn cleanup_tv_updates(cache_dir: &Path) {
    let dir = cache_dir.join("updates");
    let _ = std::fs::remove_dir_all(dir);
}

async fn download_from_candidate(
    seq: u64,
    source_label: &str,
    candidate_url: &str,
    attempt: usize,
    total_attempts: usize,
    part_path: &Path,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
    on_progress: &tauri::ipc::Channel<Value>,
) -> Result<(u64, String), String> {
    ensure_active(seq)?;
    let _ = on_progress.send(json!({
        "phase": "connecting",
        "source": source_label,
        "attempt": attempt,
        "totalAttempts": total_attempts,
        "downloaded": 0_u64,
        "total": expected_size,
        "percent": 0_u8,
    }));

    let connect_fut = get_with_doh_fallback(
        candidate_url,
        Duration::from_secs(300),
        Some("application/octet-stream"),
    );
    let mut resp = tokio::select! {
        _ = CANCEL_NOTIFY.notified() => return Err("下载已取消".into()),
        res = tokio::time::timeout(Duration::from_secs(12), connect_fut) => {
            res.map_err(|_| "连接超时".to_string())??
        }
    };
    ensure_active(seq)?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let total = expected_size
        .filter(|&n| n > 0)
        .or_else(|| resp.content_length().filter(|&n| n > 0));
    if total.is_some_and(|n| n > MAX_APK_BYTES) {
        return Err("安装包体积超出安全限制".into());
    }

    let mut file = std::fs::File::create(part_path).map_err(|_| "无法写入更新缓存目录".to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut magic = [0_u8; 4];
    let mut magic_checked = false;
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    loop {
        ensure_active(seq)?;
        let next_chunk = tokio::select! {
            _ = CANCEL_NOTIFY.notified() => return Err("下载已取消".into()),
            res = tokio::time::timeout(Duration::from_secs(15), resp.chunk()) => {
                res.map_err(|_| "下载读取超时".to_string())?
                    .map_err(|e| crate::net::err_text(&e))?
            }
        };
        let Some(chunk) = next_chunk else {
            break;
        };
        if !magic_checked {
            let prev = (downloaded as usize).min(4);
            let need = 4 - prev;
            let copy_len = need.min(chunk.len());
            magic[prev..prev + copy_len].copy_from_slice(&chunk[..copy_len]);
            if prev + copy_len == 4 {
                if &magic != b"PK\x03\x04" {
                    return Err("返回内容不是有效 APK 安装包".into());
                }
                magic_checked = true;
            }
        }
        downloaded = downloaded
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "安装包大小溢出".to_string())?;
        if downloaded > MAX_APK_BYTES {
            return Err("安装包体积超出安全限制".into());
        }
        if expected_size.is_some_and(|exp| exp > 0 && downloaded > exp) {
            return Err("返回文件超出预期字节数".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|_| "写入更新包失败（请检查电视存储空间）".to_string())?;

        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            let percent = total
                .filter(|&t| t > 0)
                .map(|t| ((downloaded.saturating_mul(100)) / t).min(99) as u8);
            let _ = on_progress.send(json!({
                "phase": "downloading",
                "source": source_label,
                "attempt": attempt,
                "totalAttempts": total_attempts,
                "downloaded": downloaded,
                "total": total,
                "percent": percent,
            }));
        }
    }

    ensure_active(seq)?;
    if !magic_checked || downloaded < 4 {
        return Err("更新包不完整".into());
    }
    if let Some(exp) = expected_size.filter(|&n| n > 0) {
        if downloaded != exp {
            return Err(format!("字节数不完整（{downloaded}/{exp}）"));
        }
    }

    let _ = on_progress.send(json!({
        "phase": "verifying",
        "source": source_label,
        "attempt": attempt,
        "totalAttempts": total_attempts,
        "downloaded": downloaded,
        "total": Some(downloaded),
        "percent": 100_u8,
    }));

    let actual_sha256 = encode_hex(&hasher.finalize());
    if let Some(exp_sha) = expected_sha256 {
        if actual_sha256 != exp_sha {
            return Err("SHA-256 完整性校验未通过".into());
        }
    }
    file.sync_all()
        .map_err(|_| "刷新更新包文件失败".to_string())?;
    Ok((downloaded, actual_sha256))
}

pub async fn download_tv_update(
    app: &tauri::AppHandle,
    url: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
    on_progress: tauri::ipc::Channel<Value>,
) -> Result<Value, String> {
    use tauri::Manager;
    let canonical = validate_tv_apk_url(url)?;
    if expected_size.is_some_and(|n| n > MAX_APK_BYTES) {
        return Err("安装包体积超出安全限制".into());
    }
    let normalized_sha = match expected_sha256.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(parse_sha256_digest(raw).ok_or("安装包校验摘要无效")?),
        None => None,
    };

    let seq = DOWNLOAD_SEQ.fetch_add(1, Ordering::AcqRel) + 1;
    CANCEL_NOTIFY.notify_waiters();

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法获取应用缓存目录".to_string())?;
    let updates_dir = cache_dir.join("updates");
    std::fs::create_dir_all(&updates_dir).map_err(|_| "无法创建更新缓存目录".to_string())?;
    let part_path = updates_dir.join(TV_APK_PART);
    let final_path = updates_dir.join(TV_APK_FILE);
    let _ = std::fs::remove_file(&part_path);
    let _ = std::fs::remove_file(&final_path);

    let candidates = download_candidates(&canonical);
    let total_attempts = candidates.len();
    let mut failures = Vec::with_capacity(total_attempts);

    for (idx, (source_label, candidate_url)) in candidates.iter().enumerate() {
        match download_from_candidate(
            seq,
            source_label,
            candidate_url,
            idx + 1,
            total_attempts,
            &part_path,
            expected_size,
            normalized_sha.as_deref(),
            &on_progress,
        )
        .await
        {
            Ok((bytes, sha256)) => {
                if let Err(err) = ensure_active(seq) {
                    let _ = std::fs::remove_file(&part_path);
                    return Err(err);
                }
                std::fs::rename(&part_path, &final_path)
                    .map_err(|_| "准备安装包文件失败".to_string())?;
                let _ = on_progress.send(json!({
                    "phase": "ready",
                    "source": source_label,
                    "attempt": idx + 1,
                    "totalAttempts": total_attempts,
                    "downloaded": bytes,
                    "total": Some(bytes),
                    "percent": 100_u8,
                }));
                crate::playback_log::record(
                    "updater.tv_downloaded",
                    json!({
                        "source": source_label,
                        "bytes": bytes,
                        "sha256_verified": normalized_sha.is_some(),
                    }),
                );
                return Ok(json!({
                    "ok": true,
                    "size": bytes,
                    "sha256": sha256,
                    "source": source_label,
                }));
            }
            Err(err) => {
                let _ = std::fs::remove_file(&part_path);
                if DOWNLOAD_SEQ.load(Ordering::Acquire) != seq || err == "下载已取消" {
                    return Err("下载已取消".into());
                }
                failures.push(format!("{source_label}: {err}"));
            }
        }
    }

    Err(format!("更新包下载失败（{}）", failures.join("；")))
}

#[cfg(test)]
mod tests {
    use super::{is_newer, version_in};

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.0.2", "1.0.1"));
        assert!(is_newer("v1.1", "1.0.9"));
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("v1.0.1", "1.0.1"));
        assert!(!is_newer("v0.9.9", "1.0.1"));
        assert!(!is_newer("", "1.0.1"));
    }
    /// tag 不是纯版本号：`hgfix-1.2.1-r5` 整串拿去比会从第一位判负（`hgfix-1` 解析成 0），
    /// 结果就是「永远没有新版本」。所以先抠出 `x.y.z` 再比。
    #[test]
    fn reads_version_out_of_tag() {
        assert_eq!(version_in("hgfix-1.2.1-r5"), "1.2.1");
        assert_eq!(version_in("v1.2.0"), "1.2.0");
        assert_eq!(version_in("HGhubX 1.2.1+hg.1"), "1.2.1");
        assert_eq!(version_in("release-notes"), "");
        assert!(is_newer(&version_in("hgfix-1.2.2-r6"), "1.2.1+hg.1"));
        assert!(is_newer(&version_in("hgfix-1.10.0-r9"), "1.9.9+hg.1"));
        assert!(!is_newer(&version_in("hgfix-1.2.1-r5"), "1.2.1+hg.1"));
    }
}
