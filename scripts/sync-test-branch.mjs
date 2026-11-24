#!/usr/bin/env node
/**
 * 维护 `test` 自动集成预览分支（由 `.github/workflows/test-preview.yml` 调用）：
 * 1. 基于单一 `test` PR 标签驱动信任继承：
 *    - 维护者给某作者任意 PR 打上 `test` 标签后，该作者后续新开 PR 自动继承 `test` 标签；
 *    - 维护者在任意 PR 上移除 `test` 标签时，自动清空该作者名下全部历史 PR 的 `test` 标签，后续不再自动触发。
 * 2. 每次触发时从最新 `origin/main` 重建 `test`，按编号顺序自动合并所有打开中、非草稿且带 `test` 标签的可合并 PR：
 *    - 非仓库所有者的外部 PR 若修改 `.github/` 目录，按安全策略拒绝自动合入；
 *    - 存在冲突的 PR 自动跳过并写入预览说明，不阻塞其它可信 PR。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_LABEL = "test";
const dryRun = process.argv.includes("--dry-run");
const token = process.env.GITHUB_TOKEN || "";
const repoSlug = process.env.GITHUB_REPOSITORY || "zxsos/HGhubX";
const [owner, repo] = repoSlug.split("/");
const repoOwner = process.env.GITHUB_REPOSITORY_OWNER || owner;
const eventName = process.env.GITHUB_EVENT_NAME || "workflow_dispatch";
const eventPath = process.env.GITHUB_EVENT_PATH || "";
const outputPath = process.env.GITHUB_OUTPUT || "";
const summaryPath = process.env.GITHUB_STEP_SUMMARY || "";
const notesOutPath = process.env.TEST_NOTES_PATH || "test-release-notes.md";

if (!token && !dryRun) {
  throw new Error("[test-preview] 缺少 GITHUB_TOKEN");
}

function setOutput(key, value) {
  console.log(`[output] ${key}=${value}`);
  if (outputPath) {
    appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

function appendSummary(markdown) {
  if (summaryPath) {
    appendFileSync(summaryPath, `${markdown}\n`);
  }
}

function git(args, { allowFail = false } = {}) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${(res.stderr || res.stdout || "").trim()}`);
  }
  return {
    ok: res.status === 0,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

async function ghApi(method, path, body) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hghubx-test-preview",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, ok: resp.ok, data };
}

async function ensureTestLabelExists() {
  const check = await ghApi("GET", `/repos/${owner}/${repo}/labels/${encodeURIComponent(TEST_LABEL)}`);
  if (check.status === 404 && !dryRun) {
    await ghApi("POST", `/repos/${owner}/${repo}/labels`, {
      name: TEST_LABEL,
      color: "0e8a16",
      description: "自动合入 test 分支并构建 test-pre 全平台预览包",
    });
  }
}

async function authorHasPriorTestPr(author, excludeNumber) {
  const query = `/repos/${owner}/${repo}/issues?creator=${encodeURIComponent(author)}&labels=${encodeURIComponent(TEST_LABEL)}&state=all&per_page=30`;
  const res = await ghApi("GET", query);
  if (!res.ok || !Array.isArray(res.data)) return false;
  return res.data.some((item) => item.pull_request && item.number !== excludeNumber);
}

async function revokeAuthorTestLabels(author) {
  for (let page = 1; page <= 5; page++) {
    const query = `/repos/${owner}/${repo}/issues?creator=${encodeURIComponent(author)}&labels=${encodeURIComponent(TEST_LABEL)}&state=all&per_page=100&page=${page}`;
    const res = await ghApi("GET", query);
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
    const prs = res.data.filter((item) => item.pull_request);
    for (const item of prs) {
      console.log(`[test-preview] 移除 @${author} 的 #${item.number} 上的 ${TEST_LABEL} 标签`);
      if (!dryRun) {
        await ghApi(
          "DELETE",
          `/repos/${owner}/${repo}/issues/${item.number}/labels/${encodeURIComponent(TEST_LABEL)}`,
        );
      }
    }
    if (res.data.length < 100) break;
  }
}

async function hasActivePreviewBuild() {
  if (dryRun || !token) return false;
  const res = await ghApi("GET", `/repos/${owner}/${repo}/actions/workflows/test-preview.yml/runs?per_page=10`);
  if (!res.ok || !Array.isArray(res.data?.workflow_runs)) return false;
  const selfRunId = String(process.env.GITHUB_RUN_ID || "");
  return res.data.workflow_runs.some(
    (run) =>
      String(run.id) !== selfRunId &&
      ["in_progress", "queued", "waiting", "pending", "requested"].includes(run.status),
  );
}

let autoLabeledPrNumber = null;
let revokedAuthor = null;

async function handlePullRequestGate(event) {
  const action = event.action || "";
  const pr = event.pull_request;
  if (!pr) return true;
  const author = pr.user?.login || "";
  const prLabels = (pr.labels || []).map((l) => l.name);

  if (action === "labeled" || action === "unlabeled") {
    if (event.label?.name !== TEST_LABEL) {
      console.log(`[test-preview] 忽略非 ${TEST_LABEL} 标签变更：${event.label?.name || ""}`);
      return false;
    }
    if (action === "unlabeled" && author) {
      revokedAuthor = author.toLowerCase();
      console.log(`[test-preview] #${pr.number} 取消了 ${TEST_LABEL} 标签，清理 @${author} 的历史继承标记`);
      await revokeAuthorTestLabels(author);
    } else if (action === "labeled" && !pr.draft) {
      autoLabeledPrNumber = pr.number;
    }
    return true;
  }

  if (["opened", "reopened", "ready_for_review", "synchronize"].includes(action)) {
    if (pr.draft) {
      console.log(`[test-preview] #${pr.number} 当前为 Draft 草稿状态，暂不自动继承或合入 test 分支`);
      return false;
    }
    let hasTest = prLabels.includes(TEST_LABEL);
    if (!hasTest && author && (await authorHasPriorTestPr(author, pr.number))) {
      console.log(`[test-preview] @${author} 曾有 ${TEST_LABEL} 标记记录，自动为 #${pr.number} 继承 ${TEST_LABEL} 标签`);
      if (!dryRun) {
        await ensureTestLabelExists();
        await ghApi("POST", `/repos/${owner}/${repo}/issues/${pr.number}/labels`, {
          labels: [TEST_LABEL],
        });
      }
      hasTest = true;
      autoLabeledPrNumber = pr.number;
    }
    if (!hasTest) {
      console.log(`[test-preview] #${pr.number} (@${author}) 未携带 ${TEST_LABEL} 标签，跳过自动合流`);
      return false;
    }
    return true;
  }

  if (action === "closed" || action === "converted_to_draft") {
    if (!prLabels.includes(TEST_LABEL)) {
      console.log(`[test-preview] 关闭/转草稿的 #${pr.number} 未携带 ${TEST_LABEL} 标签，无需重建 test`);
      return false;
    }
    return true;
  }

  return false;
}

function isNonAppFile(file) {
  return (
    file === ".github" ||
    file.startsWith(".github/") ||
    file === "docs" ||
    file.startsWith("docs/") ||
    file.endsWith(".md")
  );
}

async function main() {
  const event = eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, "utf8")) : {};
  await ensureTestLabelExists();

  if (eventName === "pull_request_target") {
    const proceed = await handlePullRequestGate(event);
    if (!proceed) {
      setOutput("should_build", "false");
      return;
    }
  }

  git(["fetch", "origin", "main"]);
  const hasRemoteTest = git(["fetch", "origin", "refs/heads/test:refs/remotes/origin/test"], { allowFail: true }).ok;
  const oldSha = hasRemoteTest
    ? git(["rev-parse", "refs/remotes/origin/test"], { allowFail: true }).stdout
    : "";
  const oldTree = hasRemoteTest
    ? git(["rev-parse", "refs/remotes/origin/test^{tree}"], { allowFail: true }).stdout
    : "";
  const hasTestPreTag = git(["fetch", "origin", "refs/tags/test-pre:refs/remotes/origin/tags/test-pre"], { allowFail: true }).ok;
  const publishedTree = hasTestPreTag
    ? git(["rev-parse", "refs/remotes/origin/tags/test-pre^{tree}"], { allowFail: true }).stdout
    : "";

  const openRes = await ghApi("GET", `/repos/${owner}/${repo}/pulls?state=open&base=main&per_page=100`);
  if (!openRes.ok || !Array.isArray(openRes.data)) {
    throw new Error(`[test-preview] 拉取 Open PR 列表失败（HTTP ${openRes.status}）`);
  }

  const candidates = openRes.data
    .filter(
      (p) =>
        !p.draft &&
        (p.user?.login || "").toLowerCase() !== revokedAuthor &&
        ((p.labels || []).some((l) => l.name === TEST_LABEL) || p.number === autoLabeledPrNumber),
    )
    .sort((a, b) => a.number - b.number);

  git(["checkout", "-B", "test", "origin/main"]);

  const mainSha = git(["rev-parse", "origin/main"]).stdout;
  const merged = [];
  const skipped = [];

  for (const pr of candidates) {
    const author = pr.user?.login || "unknown";
    const fetched = git(["fetch", "origin", `refs/pull/${pr.number}/head`], { allowFail: true });
    if (!fetched.ok) {
      skipped.push(`#${pr.number} ${pr.title}（@${author}）：拉取 PR 头提交失败`);
      continue;
    }
    const diffFiles = git(["diff", "--name-only", "origin/main...FETCH_HEAD"]).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      author.toLowerCase() !== repoOwner.toLowerCase() &&
      diffFiles.some((f) => f === ".github" || f.startsWith(".github/"))
    ) {
      skipped.push(`#${pr.number} ${pr.title}（@${author}）：外部 PR 涉及 \`.github/\` 变更，按安全规则跳过`);
      continue;
    }
    if (diffFiles.length > 0 && diffFiles.every(isNonAppFile)) {
      skipped.push(`#${pr.number} ${pr.title}（@${author}）：仅涉及文档或工作流变更，不影响客户端构建，已跳过`);
      continue;
    }

    const mergeRes = git(
      [
        "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "merge", "--no-ff", "--no-edit", "-m", `Merge PR #${pr.number} into test`, "FETCH_HEAD",
      ],
      { allowFail: true },
    );
    if (mergeRes.ok) {
      const headShort = (pr.head?.sha || "").slice(0, 7);
      merged.push(`#${pr.number} ${pr.title}（@${author}${headShort ? `，\`${headShort}\`` : ""}）`);
    } else {
      git(["merge", "--abort"], { allowFail: true });
      skipped.push(`#${pr.number} ${pr.title}（@${author}）：与当前测试基线存在代码冲突，已跳过`);
    }
  }

  const testSha = git(["rev-parse", "HEAD"]).stdout;
  const newTree = git(["rev-parse", "HEAD^{tree}"]).stdout;
  let shouldBuild = false;
  let effectiveSha = testSha;

  if (merged.length === 0) {
    if (oldTree && oldTree !== newTree && !dryRun) {
      git(["push", "--force", "origin", "HEAD:refs/heads/test"]);
      console.log("[test-preview] 当前无带 test 标签的活跃 PR，已将 test 分支重置回 main");
    }
    shouldBuild = eventName === "workflow_dispatch";
  } else if (newTree === oldTree && eventName !== "workflow_dispatch") {
    effectiveSha = oldSha || testSha;
    if (publishedTree === newTree) {
      console.log("[test-preview] test 分支与 test-pre 产物树一致，无需重复构建");
      shouldBuild = false;
    } else if (await hasActivePreviewBuild()) {
      console.log("[test-preview] 当前已有 Test Preview 构建进行中，保持原构建不中断");
      shouldBuild = false;
    } else {
      console.log("[test-preview] test 分支尚未发布到 test-pre 且无运行中构建，触发补建");
      if (!oldSha && !dryRun) {
        git(["push", "--force", "origin", "HEAD:refs/heads/test"]);
      }
      shouldBuild = true;
    }
  } else {
    if (newTree === oldTree && oldSha) {
      effectiveSha = oldSha;
    } else if (!dryRun) {
      git(["push", "--force", "origin", "HEAD:refs/heads/test"]);
    }
    shouldBuild = true;
  }

  const nowUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = [
    `# HGhubX Test Preview`,
    ``,
    `基于 \`main\`（\`${mainSha.slice(0, 7)}\`）自动合成的全平台预览构建（更新时间：\`${nowUtc}\`，测试提交：\`${effectiveSha.slice(0, 7)}\`）。`,
    `> 此预发布仅供功能尝鲜与真机回归验证，不抢占正式版 Latest，也不会触发正式版客户端自动更新提示。`,
    ``,
    `## 本次已合入的测试 PR（${merged.length}）`,
    ...(merged.length > 0 ? merged.map((item, i) => `${i + 1}. ${item}`) : [`- 无（当前直接基于 \`main\` 构建）`]),
  ];
  if (skipped.length > 0) {
    lines.push(``, `## 自动跳过的 PR（${skipped.length}）`, ...skipped.map((item) => `- ${item}`));
  }
  lines.push(``);
  const notes = lines.join("\n");
  writeFileSync(notesOutPath, notes);
  appendSummary(notes);

  setOutput("should_build", shouldBuild ? "true" : "false");
  setOutput("commit_sha", effectiveSha);
  setOutput("short_sha", effectiveSha.slice(0, 7));
  setOutput("merged_count", String(merged.length));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
