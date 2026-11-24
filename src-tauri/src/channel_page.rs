use dom_query::{Document, Selection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DEFAULT_SSR_PAGE_SIZE: u32 = 39;
const DEFAULT_LIST_SSR_PAGE_SIZE: u32 = 28;
const DEFAULT_GOSSIP_SSR_PAGE_SIZE: u32 = 12;
const PREVIEW_TRUNCATE_LIMIT: u32 = 20;

#[derive(Debug, Serialize)]
struct ChannelVideoCard {
    id: i64,
    title: String,
    cover: String,
    tags: Vec<String>,
    score: f64,
    episode_count: u32,
    total_episodes: u32,
    hot: u64,
    like_count: u64,
    collect_count: u64,
    comment_count: u64,
    is_finished: bool,
    is_original: u8,
    is_hot: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_at: Option<u64>,
}

fn normalized_string(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalized_text(selection: Selection<'_>) -> String {
    normalized_string(&selection.text())
}

fn video_id_from_str(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let id = trimmed.parse::<i64>().ok()?;
    (id > 0 && id <= JS_MAX_SAFE_INTEGER).then_some(id)
}

fn video_id_from_href(href: &str) -> Option<i64> {
    let id = href.trim().strip_prefix("/video/")?.strip_suffix('/')?;
    video_id_from_str(id)
}

fn post_id_from_href(href: &str) -> Option<i64> {
    let trimmed = href.trim();
    let without_origin = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .and_then(|rest| rest.find('/').map(|idx| &rest[idx..]))
        .unwrap_or(trimmed);
    let path = without_origin.split(['?', '#']).next().unwrap_or("");
    let id = path.strip_prefix("/archives/")?.strip_suffix('/')?;
    video_id_from_str(id)
}

fn parse_score(raw: &str) -> f64 {
    let trimmed = raw.trim().trim_end_matches('分').trim();
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

fn first_u32_in_str(raw: &str) -> Option<u32> {
    let mut started = false;
    let mut value: u32 = 0;
    for ch in raw.chars() {
        if let Some(digit) = ch.to_digit(10) {
            started = true;
            value = value.saturating_mul(10).saturating_add(digit);
        } else if started {
            break;
        }
    }
    started.then_some(value)
}

fn parse_episode(raw: &str) -> (bool, u32, u32) {
    let text = normalized_string(raw);
    if text.is_empty() {
        return (false, 0, 0);
    }
    let finished = text.contains('全') || text.contains("完结");
    let count = if let Some(rest) = text.split("更新至").nth(1) {
        first_u32_in_str(rest)
    } else if let Some(rest) = text.split('全').nth(1) {
        first_u32_in_str(rest)
    } else {
        first_u32_in_str(&text)
    }
    .unwrap_or(0);
    let total = if finished { count } else { 0 };
    (finished, count, total)
}

fn parse_views(raw: &str) -> u64 {
    let text = raw.trim().replace(',', "");
    if text.is_empty() {
        return 0;
    }
    let lower = text.to_ascii_lowercase();
    let (num_part, multiplier) = if let Some(stripped) = lower.strip_suffix('k') {
        (stripped, 1_000.0)
    } else if let Some(stripped) = text.strip_suffix('千') {
        (stripped, 1_000.0)
    } else if let Some(stripped) = lower.strip_suffix('w') {
        (stripped, 10_000.0)
    } else if let Some(stripped) = text.strip_suffix('万') {
        (stripped, 10_000.0)
    } else if let Some(stripped) = text.strip_suffix('亿') {
        (stripped, 100_000_000.0)
    } else {
        (lower.as_str(), 1.0)
    };
    let numeric: String = num_part
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    let parsed = numeric.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0);
    parsed.map(|v| (v * multiplier).round() as u64).unwrap_or(0)
}

fn extract_cover(card: &Selection<'_>) -> String {
    let img = card.select(".hg-drama-card__cover img");
    if let Some(src) = img.attr("data-src") {
        let trimmed = src.trim();
        if !trimmed.is_empty() && !trimmed.contains("cover-placeholder") {
            return trimmed.to_string();
        }
    }
    if let Some(src) = img.attr("src") {
        let trimmed = src.trim();
        if !trimmed.is_empty() && !trimmed.contains("cover-placeholder") {
            return trimmed.to_string();
        }
    }
    String::new()
}

fn parse_total_count(raw: &str) -> u64 {
    let digits: String = raw
        .split_once('共')
        .map(|(_, rest)| rest)
        .unwrap_or(raw)
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ',')
        .filter(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<u64>().unwrap_or(0)
}

fn parse_drama_grid(
    scope: &Selection<'_>,
    grid: &Selection<'_>,
    page: u32,
    requested_size: u32,
    total_hint: u64,
    default_page_size: u32,
    empty_err: String,
) -> Result<Value, String> {
    let page = page.max(1);
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for card_node in grid.select(".hg-drama-card").iter() {
        let card = Selection::from(card_node);
        let id = card
            .attr("data-track-id")
            .and_then(|value| video_id_from_str(&value))
            .or_else(|| {
                card.select(".hg-drama-card__cover-link")
                    .attr("href")
                    .and_then(|href| video_id_from_href(&href))
            })
            .or_else(|| {
                card.select(".hg-drama-card__title a")
                    .attr("href")
                    .and_then(|href| video_id_from_href(&href))
            });
        let Some(id) = id else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }

        let title = {
            let text = normalized_text(card.select(".hg-drama-card__title"));
            if !text.is_empty() {
                text
            } else {
                card.attr("data-track-title")
                    .map(|value| normalized_string(&value))
                    .unwrap_or_default()
            }
        };
        if title.is_empty() {
            continue;
        }

        let cover = extract_cover(&card);
        let score = parse_score(&normalized_text(card.select(".hg-drama-card__score")));
        let (is_finished, episode_count, total_episodes) =
            parse_episode(&normalized_text(card.select(".hg-drama-card__episode")));
        let hot = parse_views(&normalized_text(card.select(".hg-drama-card__views")));

        let mut tags = Vec::new();
        let mut seen_tags = HashSet::new();
        for tag_node in card.select(".hg-drama-card__tags .hg-tag").iter() {
            let tag = normalized_text(Selection::from(tag_node));
            if !tag.is_empty() && seen_tags.insert(tag.clone()) {
                tags.push(tag);
            }
        }

        let mut is_original: u8 = 0;
        let mut is_hot: u8 = 0;
        let mut new_at: Option<u64> = None;
        for badge_node in card.select(".hg-drama-card__badges .hg-drama-card__badge").iter() {
            let badge = Selection::from(badge_node);
            let class_attr = badge.attr("class").unwrap_or_default();
            let badge_text = normalized_string(&badge.text());
            if badge_text == "原创" {
                is_original = 1;
            } else if class_attr.contains("hg-drama-card__badge--hot") || badge_text == "热播" {
                is_hot = 1;
            } else if class_attr.contains("hg-drama-card__badge--new") || badge_text == "新片" {
                let parsed = badge
                    .attr("data-new-at")
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .filter(|value| *value > 0);
                new_at = Some(parsed.unwrap_or(1));
            }
        }

        items.push(ChannelVideoCard {
            id,
            title,
            cover,
            tags,
            score,
            episode_count,
            total_episodes,
            hot,
            like_count: 0,
            collect_count: 0,
            comment_count: 0,
            is_finished,
            is_original,
            is_hot,
            new_at,
        });
    }

    if items.is_empty() {
        return Err(empty_err);
    }

    let full_page_len = items.len() as u32;
    let mut pages = scope
        .select(".hg-pager__jump, [data-hg-pager-jump]")
        .attr("data-pages")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0);

    if pages == 0 {
        for pager_link in scope
            .select(".hg-pager a.hg-pager__page, .hg-pager span.hg-pager__page")
            .iter()
        {
            if let Ok(num) = normalized_text(Selection::from(pager_link)).parse::<u32>() {
                if num > pages {
                    pages = num;
                }
            }
        }
    }

    let total = total_hint.max(items.len() as u64);
    if pages == 0 {
        let per_page = full_page_len.max(default_page_size) as u64;
        pages = ((total + per_page - 1) / per_page).max(page as u64) as u32;
    }

    // 仅分类总览预览行（page=1 且 size < 20）按需截断；频道分页页保留整页卡片，
    // 防止官网每页条数多于 20 时前端翻到第 2 页跳过尾部条目。
    if page == 1 && requested_size > 0 && requested_size < PREVIEW_TRUNCATE_LIMIT {
        items.truncate(requested_size as usize);
    }

    let response_size = items.len() as u32;
    Ok(json!({
        "items": items,
        "pagination": {
            "page": page,
            "pages": pages.max(page),
            "size": response_size,
            "total": total,
        }
    }))
}

fn parse_channel_html(
    html: &str,
    panel: &str,
    page: u32,
    requested_size: u32,
) -> Result<Value, String> {
    let document = Document::from(html);
    let section = document.select("section.hg-channel-page");
    if section.is_empty() {
        return Err("官网频道页缺少频道主体区域".into());
    }

    let grid_selector = format!(".hg-card-grid[data-channel-panel=\"{panel}\"]");
    let grid = section.select(&grid_selector);
    if grid.is_empty() {
        return Err(format!("官网频道页缺少 {panel} 面板"));
    }
    if grid.attr("hidden").is_some() {
        return Err(format!("官网频道页 {panel} 面板处于隐藏状态"));
    }

    let panel_total = grid
        .attr("data-panel-total")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);

    parse_drama_grid(
        &section,
        &grid,
        page,
        requested_size,
        panel_total,
        DEFAULT_SSR_PAGE_SIZE,
        format!("官网频道页 {panel} 面板没有可用条目"),
    )
}

pub(crate) fn parse_list_page_html(
    html: &str,
    page: u32,
    requested_size: u32,
) -> Result<Value, String> {
    let document = Document::from(html);
    let section = document.select("section.hg-list-page");
    if section.is_empty() {
        return Err("官网列表页缺少主体区域".into());
    }

    let grid = section.select(".hg-card-grid").first();
    if grid.is_empty() {
        return Err("官网列表页缺少卡片网格".into());
    }

    let total_hint = parse_total_count(&normalized_text(section.select(".hg-page-header__extra")));
    parse_drama_grid(
        &section,
        &grid,
        page,
        requested_size,
        total_hint,
        DEFAULT_LIST_SSR_PAGE_SIZE,
        "官网列表页没有可用条目".into(),
    )
}

async fn fetch_html(path: &str) -> Result<String, String> {
    let base = crate::net::base();
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let referer = format!("{base}/");
        let url = format!("{base}{path}");
        let mut response = crate::net::get(
            &url,
            REQUEST_TIMEOUT,
            Some("text/html,application/xhtml+xml"),
            Some(&referer),
        )
        .await?;

        if !response.status().is_success() {
            return Err(format!("官网频道页请求失败（HTTP {}）", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTML_BYTES as u64)
        {
            return Err("官网频道页超过 2 MiB 限制".into());
        }

        let mut html = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| crate::net::err_text(&error))?
        {
            if html.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
                return Err("官网频道页超过 2 MiB 限制".into());
            }
            html.extend_from_slice(&chunk);
        }
        String::from_utf8(html).map_err(|_| "官网频道页不是有效的 UTF-8 HTML".into())
    })
    .await
    .map_err(|_| "获取官网频道页超时（12 秒）".to_string())?
}

fn category_route(cate: &str, page: u32, sort: Option<&str>) -> Option<(String, &'static str)> {
    if !matches!(cate, "ai-duanju" | "ai-manju") {
        return None;
    }
    let page = page.max(1);
    let (sub, panel) = match sort.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("latest") => ("", "latest"),
        Some("hot_window") | Some("hot") => ("hot/", "hot"),
        Some("random") => ("random/", "random"),
        _ => return None,
    };
    let path = if page == 1 {
        format!("/{cate}/{sub}")
    } else {
        format!("/{cate}/{sub}{page}/")
    };
    Some((path, panel))
}

fn original_route(cate: &str, page: u32) -> Option<(String, &'static str)> {
    let page = page.max(1);
    let (prefix, panel) = match cate.trim() {
        "all" => ("/original/", "drama"),
        "ai-manju" => ("/original/manju/", "comic"),
        "ai-duanju" => ("/original/duanju/", "short"),
        _ => return None,
    };
    let path = if page == 1 {
        prefix.to_string()
    } else {
        format!("{prefix}{page}/")
    };
    Some((path, panel))
}

fn list_route(cate: &str, page: u32) -> Option<String> {
    let prefix = match cate.trim() {
        "newest" => "/newest/",
        "recommend" => "/recommend/",
        _ => return None,
    };
    let page = page.max(1);
    Some(if page == 1 {
        prefix.to_string()
    } else {
        format!("{prefix}{page}/")
    })
}

pub async fn fetch_category(
    cate: &str,
    page: u32,
    size: u32,
    sort: Option<&str>,
) -> Result<Value, String> {
    let page = page.max(1);
    if let Some(path) = list_route(cate, page) {
        let html = fetch_html(&path).await?;
        return parse_list_page_html(&html, page, size);
    }
    let (path, panel) = category_route(cate, page, sort)
        .ok_or_else(|| format!("不支持的官网频道映射：{cate}"))?;
    let html = fetch_html(&path).await?;
    parse_channel_html(&html, panel, page, size)
}

pub async fn fetch_original(cate: &str, page: u32, size: u32) -> Result<Value, String> {
    let page = page.max(1);
    let (path, panel) =
        original_route(cate, page).ok_or_else(|| format!("不支持的原创频道映射：{cate}"))?;
    let html = fetch_html(&path).await?;
    parse_channel_html(&html, panel, page, size)
}

fn extract_img_cover(img: Selection<'_>) -> String {
    for attr in ["data-src", "src"] {
        if let Some(raw) = img.attr(attr) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && !trimmed.contains("cover-placeholder") {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

pub(crate) fn parse_hot_rank_html(html: &str) -> Result<Value, String> {
    let doc = Document::from(html);
    let list = doc.select("section.hg-rank-page [data-rank-list]");
    let scope = if list.length() > 0 {
        list
    } else {
        doc.select("section.hg-rank-page")
    };
    if scope.length() == 0 {
        return Err("官网热播榜容器缺失".to_string());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for card_node in scope.select(".hg-rank-item[data-rank-item]").iter() {
        let card = Selection::from(card_node);
        let video_id = card
            .attr("data-track-id")
            .and_then(|value| video_id_from_str(&value))
            .or_else(|| {
                card.select(".hg-rank-item__cover")
                    .attr("href")
                    .and_then(|href| video_id_from_href(&href))
            })
            .or_else(|| {
                card.select(".hg-rank-item__title a")
                    .attr("href")
                    .and_then(|href| video_id_from_href(&href))
            });
        let Some(video_id) = video_id else {
            continue;
        };
        if !seen.insert(video_id) {
            continue;
        }

        let title = {
            let link = normalized_text(card.select(".hg-rank-item__title a"));
            if !link.is_empty() {
                link
            } else {
                let heading = normalized_text(card.select(".hg-rank-item__title"));
                if !heading.is_empty() {
                    heading
                } else {
                    card.attr("data-track-title")
                        .map(|value| normalized_string(&value))
                        .unwrap_or_default()
                }
            }
        };
        if title.is_empty() {
            continue;
        }

        let rank_digits: String = normalized_text(card.select(".hg-rank-num"))
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect();
        let rank = rank_digits
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0)
            .unwrap_or_else(|| (items.len() + 1) as u32);

        let cover = extract_img_cover(card.select(".hg-rank-item__cover img"));
        let cate_name = card
            .attr("data-track-type-name")
            .map(|value| normalized_string(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalized_text(card.select(".hg-rank-item__tags > span:first-child")));

        let mut tags = Vec::new();
        let mut seen_tags = HashSet::new();
        for tag_node in card.select(".hg-rank-item__tags a[href*='/tag/']").iter() {
            let tag = normalized_text(Selection::from(tag_node));
            if !tag.is_empty() && seen_tags.insert(tag.clone()) {
                tags.push(tag);
            }
        }

        let score = parse_score(&normalized_text(card.select(".hg-rank-item__score")));
        let (is_finished, episode_count, _) =
            parse_episode(&normalized_text(card.select(".hg-rank-item__ep")));

        let metric_label = {
            let label = normalized_text(card.select(".hg-rank-item__heat-label"));
            if !label.is_empty() {
                label
            } else {
                let side = normalized_text(card.select(".hg-rank-item__label"));
                if !side.is_empty() {
                    side
                } else {
                    "实时热度".to_string()
                }
            }
        };
        let metric_value = {
            let raw = normalized_text(card.select(".hg-rank-item__heat-value"));
            let text = if !raw.is_empty() {
                raw
            } else {
                normalized_text(card.select(".hg-rank-item__value"))
            };
            parse_views(&text)
        };

        items.push(json!({
            "rank": rank,
            "video_id": video_id,
            "title": title,
            "cover": cover,
            "tags": tags,
            "score": score,
            "cate_name": cate_name,
            "episode_count": episode_count,
            "is_finished": is_finished,
            "intervened": false,
            "metric_label": metric_label,
            "metric_value": metric_value,
            "metrics": { "collect": 0, "comment": 0, "like": 0, "play": 0 }
        }));
    }

    if items.is_empty() {
        return Err("官网热播榜未解析到有效条目".to_string());
    }

    Ok(json!({
        "type": "hot",
        "items": items,
    }))
}

pub async fn fetch_hot_rank() -> Result<Value, String> {
    let html = fetch_html("/ranks/hot/").await?;
    parse_hot_rank_html(&html)
}

fn gossip_tag_window(page: u32) -> (u32, u32) {
    if page <= 1 {
        return (1, 24);
    }
    let m = page - 1;
    for d in [3, 4, 5, 6, 7, 8] {
        let r = m % d;
        if r >= 1 && r <= d - 2 {
            return (m / d + 1, 12 * d);
        }
    }
    (m / 4 + 1, 48)
}

fn parse_gossip_total(raw: &str) -> u64 {
    let after = raw.split('共').nth(1).unwrap_or(raw);
    let digits: String = after
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse::<u64>().unwrap_or(0)
}

pub(crate) fn parse_gossip_posts_html(
    html: &str,
    page: u32,
    requested_size: u32,
    enrichment: &HashMap<i64, Value>,
) -> Result<Value, String> {
    let page = page.max(1);
    let doc = Document::from(html);
    let section = doc.select("section.hg-community-page");
    if section.length() == 0 {
        return Err("官网吃瓜页容器缺失".to_string());
    }
    let feed = section.select(".hg-cate-feed");
    if feed.length() == 0 {
        return Err("官网吃瓜页列表缺失".to_string());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for card_node in feed.select("a.hg-cate-feed__card").iter() {
        let card = Selection::from(card_node);
        let id = card
            .attr("data-track-item-id")
            .and_then(|value| video_id_from_str(&value))
            .or_else(|| card.attr("href").and_then(|href| post_id_from_href(&href)));
        let Some(id) = id else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }

        let title = {
            let heading = normalized_text(card.select(".hg-cate-feed__title"));
            if !heading.is_empty() {
                heading
            } else {
                card.attr("data-track-item-name")
                    .map(|value| normalized_string(&value))
                    .unwrap_or_default()
            }
        };
        if title.is_empty() {
            continue;
        }

        let entry = enrichment.get(&id);
        let cover = {
            let ssr_cover = extract_img_cover(card.select(".hg-cate-feed__cover img"));
            if !ssr_cover.is_empty() {
                ssr_cover
            } else {
                entry
                    .and_then(|v| v.get("cover"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string()
            }
        };
        let desc = {
            let intro = normalized_text(card.select(".hg-cate-feed__intro"));
            if !intro.is_empty() {
                intro
            } else {
                entry
                    .and_then(|v| v.get("desc"))
                    .and_then(Value::as_str)
                    .map(normalized_string)
                    .unwrap_or_default()
            }
        };
        let hot = {
            let stats_raw = card
                .select(".hg-cate-feed__stats span")
                .iter()
                .next()
                .map(|node| normalized_text(Selection::from(node)))
                .unwrap_or_default();
            let trimmed = stats_raw
                .trim_end_matches("次阅读")
                .trim_end_matches("阅读")
                .trim_end_matches("次浏览")
                .trim_end_matches("浏览")
                .trim();
            let ssr_hot = parse_views(trimmed);
            if ssr_hot > 0 {
                ssr_hot
            } else {
                entry.and_then(|v| v.get("hot")).and_then(Value::as_u64).unwrap_or(0)
            }
        };
        let created_at = entry
            .and_then(|v| v.get("created_at"))
            .and_then(Value::as_str)
            .map(normalized_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| normalized_text(card.select(".hg-cate-feed__date")));
        let publish_time = entry
            .and_then(|v| v.get("publish_time"))
            .and_then(Value::as_str)
            .map(normalized_string)
            .unwrap_or_default();
        let tags: Vec<String> = entry
            .and_then(|v| v.get("tags"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(normalized_string)
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        items.push(json!({
            "id": id,
            "title": title,
            "cover": cover,
            "desc": desc,
            "tags": tags,
            "hot": hot,
            "created_at": created_at,
            "publish_time": publish_time,
        }));
    }

    if items.is_empty() {
        return Err("官网吃瓜页未解析到有效条目".to_string());
    }

    let full_page_len = items.len() as u32;
    let parsed_total = parse_gossip_total(&normalized_text(section.select(".hg-section-title")));
    let total = parsed_total.max(items.len() as u64);

    let mut pages = section
        .select("[data-hg-pager-jump]")
        .attr("data-pages")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0);
    for page_node in section.select("nav.hg-pager .hg-pager__page").iter() {
        if let Ok(num) = normalized_text(Selection::from(page_node)).parse::<u32>() {
            if num > pages {
                pages = num;
            }
        }
    }
    if pages == 0 {
        let per_page = full_page_len.max(DEFAULT_GOSSIP_SSR_PAGE_SIZE) as u64;
        pages = ((total + per_page - 1) / per_page).max(page as u64) as u32;
    }

    if page == 1 && requested_size > 0 && requested_size < DEFAULT_GOSSIP_SSR_PAGE_SIZE {
        items.truncate(requested_size as usize);
    }

    let response_size = items.len() as u32;
    Ok(json!({
        "items": items,
        "pagination": {
            "page": page,
            "pages": pages.max(page),
            "size": response_size,
            "total": total,
        }
    }))
}

pub async fn fetch_gossip_posts(page: u32, size: u32) -> Result<Value, String> {
    let page = page.max(1);
    let html_path = if page == 1 {
        "/blog/gossip/".to_string()
    } else {
        format!("/blog/gossip/{page}/")
    };
    let (api_page, api_size) = gossip_tag_window(page);
    let origin = crate::net::base();
    let api_path = format!(
        "/api/posts/category/remen-chigua?page={api_page}&size={api_size}&sort=latest"
    );
    let (html_res, json_res) = tokio::join!(
        fetch_html(&html_path),
        crate::net::edge(&origin, "GET", &api_path, None, None)
    );
    let mut enrichment = HashMap::new();
    if let Ok(val) = json_res {
        if let Some(arr) = val.get("items").and_then(Value::as_array) {
            for item in arr {
                if let Some(id) = item.get("id").and_then(Value::as_i64) {
                    enrichment.insert(id, item.clone());
                }
            }
        }
    }
    parse_gossip_posts_html(&html_res?, page, size, &enrichment)
}

#[cfg(test)]
mod tests {
    use super::{category_route, original_route, parse_channel_html};

    const SAMPLE_CHANNEL_HTML: &str = r#"
        <header>
          <div class="hg-card-grid" data-channel-panel="latest">
            <div class="hg-drama-card" data-track-id="99999">
              <h3 class="hg-drama-card__title"><a href="/video/99999/">页头噪声卡片</a></h3>
            </div>
          </div>
        </header>
        <section class="hg-channel-page">
          <div class="hg-card-grid is-active" data-channel-panel="latest" data-panel-total="1624">
            <div class="hg-drama-card" data-track-id="13731" data-track-title="上瘾">
              <div class="hg-drama-card__cover">
                <a class="hg-drama-card__cover-link" href="/video/13731/">
                  <img src="/static/web/images/cover-placeholder.png" data-src="https://pic.example.test/cover1.jpg" alt="上瘾" />
                </a>
                <span class="hg-drama-card__badges">
                  <span class="hg-drama-card__badge">原创</span>
                  <span class="hg-drama-card__badge hg-drama-card__badge--hot">热播</span>
                  <span class="hg-drama-card__badge hg-drama-card__badge--new" data-new-at="1795259930">新片</span>
                </span>
                <span class="hg-drama-card__score">8.7分</span>
                <span class="hg-drama-card__episode">更新至2集</span>
                <span class="hg-drama-card__views"><img src="/icon.svg" alt="" />16.6w</span>
              </div>
              <div class="hg-drama-card__body">
                <h3 class="hg-drama-card__title"><a href="/video/13731/">上瘾</a></h3>
                <div class="hg-drama-card__tags">
                  <a class="hg-tag" href="/tag/dushi/">都市</a>
                  <a class="hg-tag" href="/tag/xiaoyuan/">校园</a>
                  <a class="hg-tag" href="/tag/dushi/">都市</a>
                </div>
              </div>
            </div>
            <div class="hg-drama-card" data-track-id="10175">
              <div class="hg-drama-card__cover">
                <a class="hg-drama-card__cover-link" href="/video/10175/">
                  <img src="https://pic.example.test/cover2.jpg" alt="完结剧" />
                </a>
                <span class="hg-drama-card__score">9.1分</span>
                <span class="hg-drama-card__episode">全21集</span>
                <span class="hg-drama-card__views">1.2亿</span>
              </div>
              <div class="hg-drama-card__body">
                <h3 class="hg-drama-card__title"><a href="/video/10175/">完结剧 &amp; 番外</a></h3>
                <div class="hg-drama-card__tags"><a class="hg-tag" href="/tag/xiandai/">现代</a></div>
              </div>
            </div>
          </div>
          <div class="hg-card-grid" data-channel-panel="hot" data-panel-total="1729" hidden="">
            <div class="hg-drama-card" data-track-id="88888">
              <h3 class="hg-drama-card__title"><a href="/video/88888/">隐藏热播面板</a></h3>
            </div>
          </div>
          <nav class="hg-pager">
            <span class="hg-pager__jump" data-pages="42"></span>
          </nav>
        </section>
    "#;

    #[test]
    fn routes_map_category_and_original_pages_and_reject_unknown() {
        assert_eq!(category_route("ai-duanju", 1, Some("latest")), Some(("/ai-duanju/".into(), "latest")));
        assert_eq!(category_route("ai-duanju", 2, None), Some(("/ai-duanju/2/".into(), "latest")));
        assert_eq!(category_route("ai-duanju", 1, Some("hot_window")), Some(("/ai-duanju/hot/".into(), "hot")));
        assert_eq!(category_route("ai-duanju", 3, Some("hot_window")), Some(("/ai-duanju/hot/3/".into(), "hot")));
        assert_eq!(category_route("ai-manju", 1, Some("random")), Some(("/ai-manju/random/".into(), "random")));
        assert_eq!(category_route("ai-manju", 2, Some("random")), Some(("/ai-manju/random/2/".into(), "random")));
        assert_eq!(category_route("unknown", 1, Some("latest")), None);
        assert_eq!(category_route("ai-duanju", 1, Some("unsupported")), None);

        assert_eq!(original_route("all", 1), Some(("/original/".into(), "drama")));
        assert_eq!(original_route("all", 2), Some(("/original/2/".into(), "drama")));
        assert_eq!(original_route("ai-manju", 1), Some(("/original/manju/".into(), "comic")));
        assert_eq!(original_route("ai-duanju", 2), Some(("/original/duanju/2/".into(), "short")));
        assert_eq!(original_route("other", 1), None);
    }

    #[test]
    fn parses_active_panel_badges_tags_episodes_views_and_pagination() {
        let full = parse_channel_html(SAMPLE_CHANNEL_HTML, "latest", 1, 20).unwrap();
        let items = full["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], 13731);
        assert_eq!(items[0]["title"], "上瘾");
        assert_eq!(items[0]["cover"], "https://pic.example.test/cover1.jpg");
        assert_eq!(items[0]["score"], 8.7);
        assert_eq!(items[0]["episode_count"], 2);
        assert_eq!(items[0]["total_episodes"], 0);
        assert_eq!(items[0]["is_finished"], false);
        assert_eq!(items[0]["hot"], 166_000);
        assert_eq!(items[0]["is_original"], 1);
        assert_eq!(items[0]["is_hot"], 1);
        assert_eq!(items[0]["new_at"], 1_795_259_930_u64);
        assert_eq!(items[0]["tags"], serde_json::json!(["都市", "校园"]));

        assert_eq!(items[1]["id"], 10175);
        assert_eq!(items[1]["title"], "完结剧 & 番外");
        assert_eq!(items[1]["is_finished"], true);
        assert_eq!(items[1]["episode_count"], 21);
        assert_eq!(items[1]["total_episodes"], 21);
        assert_eq!(items[1]["hot"], 120_000_000);
        assert_eq!(items[1]["is_original"], 0);
        assert_eq!(items[1]["is_hot"], 0);
        assert!(items[1].get("new_at").is_none());

        assert_eq!(full["pagination"]["page"], 1);
        assert_eq!(full["pagination"]["pages"], 42);
        assert_eq!(full["pagination"]["total"], 1624);

        let preview = parse_channel_html(SAMPLE_CHANNEL_HTML, "latest", 1, 1).unwrap();
        assert_eq!(preview["items"].as_array().unwrap().len(), 1);
        assert_eq!(preview["pagination"]["pages"], 42);
    }

    #[test]
    fn rejects_hidden_missing_and_outside_section_panels() {
        assert!(parse_channel_html(SAMPLE_CHANNEL_HTML, "hot", 1, 20).is_err());
        assert!(parse_channel_html(SAMPLE_CHANNEL_HTML, "random", 1, 20).is_err());
        let outside_only = r#"<header><div class="hg-card-grid" data-channel-panel="latest"><div class="hg-drama-card" data-track-id="1"><h3 class="hg-drama-card__title">外部</h3></div></div></header>"#;
        assert!(parse_channel_html(outside_only, "latest", 1, 20).is_err());
    }
}
