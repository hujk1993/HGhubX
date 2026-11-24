#!/usr/bin/env node
// Keep Android's generated project disposable: apply the tracked TV manifest,
// launcher resources and native window policy after every `tauri android init`.
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const android = join(root, "src-tauri", "gen", "android");
const source = join(root, "src-tauri", "tv", "android");
const main = join(android, "app", "src", "main");
const manifestPath = join(main, "AndroidManifest.xml");
const activityPath = join(main, "java", "com", "hghubx", "tv", "MainActivity.kt");
const gradlePath = join(android, "app", "build.gradle.kts");
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.tv.conf.json"), "utf8"));

function fail(message) {
  throw new Error(`[tv] ${message}`);
}

if (config.identifier !== "com.hghubx.tv" || config.productName !== "HGhubX TV") {
  fail("Android TV 配置的产品名或包名发生变化，请同步 TV 资源与 Activity");
}
if (!existsSync(android)) {
  console.log("[tv] skip patch: src-tauri/gen/android does not exist yet");
  process.exit(0);
}
for (const path of [manifestPath, activityPath, gradlePath]) {
  if (!existsSync(path)) fail(`缺少 ${path}；请先使用 tauri.tv.conf.json 运行 tauri android init`);
}
const gradle = readFileSync(gradlePath, "utf8");
if (!/\bapplicationId\s*=\s*"com\.hghubx\.tv"/.test(gradle) ||
    !/\bnamespace\s*=\s*"com\.hghubx\.tv"/.test(gradle)) {
  fail("生成工程不是 com.hghubx.tv；请重新运行 tauri android init，避免覆盖普通版");
}

function active(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
}
function matches(xml, pattern) {
  return [...active(xml).matchAll(pattern)];
}
function attr(tag, name) {
  return tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`))?.[1];
}
function setAttr(tag, name, value) {
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*)["'][^"']*["']`, "g");
  const found = [...tag.matchAll(pattern)];
  if (found.length > 1) fail(`Manifest 重复属性 ${name}`);
  if (found.length) return tag.replace(pattern, (_, prefix) => `${prefix}"${value}"`);
  return tag.replace(/\s*(\/?>)$/, ` ${name}="${value}"$1`);
}
function replaceMatch(xml, match, value) {
  return xml.slice(0, match.index) + value + xml.slice(match.index + match[0].length);
}
function setPermission(xml, name) {
  const found = matches(xml, /<uses-permission\b[^>]*\/>/g)
    .filter((match) => attr(match[0], "android:name") === name);
  if (found.length > 1) fail(`Manifest 重复 permission ${name}`);
  if (found.length) return xml;
  const applications = matches(xml, /<application\b/g);
  if (applications.length !== 1) fail("Manifest 缺少唯一 application");
  const start = applications[0].index;
  return xml.slice(0, start) + `<uses-permission android:name="${name}" />\n    ` + xml.slice(start);
}
function setFeature(xml, name) {
  const found = matches(xml, /<uses-feature\b[^>]*\/>/g)
    .filter((match) => attr(match[0], "android:name") === name);
  if (found.length > 1) fail(`Manifest 重复 feature ${name}`);
  if (found.length) return replaceMatch(xml, found[0], setAttr(found[0][0], "android:required", "false"));
  const applications = matches(xml, /<application\b/g);
  if (applications.length !== 1) fail("Manifest 缺少唯一 application");
  const start = applications[0].index;
  return xml.slice(0, start) + `<uses-feature android:name="${name}" android:required="false" />\n\n    ` + xml.slice(start);
}
function setUpdateFileProvider(xml) {
  const authority = "com.hghubx.tv.fileprovider";
  const block = `<provider\n            android:name="androidx.core.content.FileProvider"\n            android:authorities="${authority}"\n            android:exported="false"\n            android:grantUriPermissions="true">\n            <meta-data\n                android:name="android.support.FILE_PROVIDER_PATHS"\n                android:resource="@xml/hghubx_tv_file_paths" />\n        </provider>`;
  const providers = matches(xml, /<provider\b[\s\S]*?<\/provider\s*>/g)
    .filter((match) => attr(match[0], "android:authorities") === authority);
  if (providers.length > 1) fail(`Manifest 重复 provider ${authority}`);
  if (providers.length) return replaceMatch(xml, providers[0], block);
  const closings = matches(xml, /<\/application\s*>/g);
  if (closings.length !== 1) fail("Manifest 缺少唯一 application 结束标签");
  return xml.slice(0, closings[0].index) + `    ${block}\n    ` + xml.slice(closings[0].index);
}

let manifest = readFileSync(manifestPath, "utf8");
manifest = setPermission(manifest, "android.permission.REQUEST_INSTALL_PACKAGES");
manifest = setFeature(manifest, "android.software.leanback");
manifest = setFeature(manifest, "android.hardware.touchscreen");
const applications = matches(manifest, /<application\b[^>]*>/g);
if (applications.length !== 1) fail("Manifest 缺少唯一 application");
let application = setAttr(applications[0][0], "android:banner", "@drawable/hghubx_tv_banner");
application = setAttr(application, "android:label", "@string/hghubx_tv_name");
manifest = replaceMatch(manifest, applications[0], application);

const activities = matches(manifest, /(<activity\b[^>]*>)([\s\S]*?)(<\/activity\s*>)/g)
  .filter((match) => [".MainActivity", "com.hghubx.tv.MainActivity"].includes(attr(match[1], "android:name")));
if (activities.length !== 1) fail("Manifest 缺少唯一 MainActivity");
const activity = activities[0];
let opening = setAttr(activity[1], "android:screenOrientation", "landscape");
opening = setAttr(opening, "android:banner", "@drawable/hghubx_tv_banner");
opening = setAttr(opening, "android:label", "@string/hghubx_tv_name");
// Resize for an on-screen keyboard; native insets additionally cover newer
// edge-to-edge behavior. Their union is applied once at the content container.
opening = setAttr(opening, "android:windowSoftInputMode", "adjustResize");
const originalBody = manifest.slice(activity.index + activity[1].length,
  activity.index + activity[1].length + activity[2].length);
let body = originalBody;
const filters = matches(body, /<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter\s*>/g)
  .filter((match) => matches(match[0], /<action\b[^>]*\/>/g)
    .some((action) => attr(action[0], "android:name") === "android.intent.action.MAIN"));
if (filters.length !== 1) fail("MainActivity 缺少唯一 MAIN intent-filter");
let filter = body.slice(filters[0].index, filters[0].index + filters[0][0].length);
if (!matches(filter, /<category\b[^>]*\/>/g)
  .some((category) => attr(category[0], "android:name") === "android.intent.category.LEANBACK_LAUNCHER")) {
  filter = filter.replace(/<\/intent-filter\s*>$/, '    <category android:name="android.intent.category.LEANBACK_LAUNCHER" />\n            </intent-filter>');
}
body = replaceMatch(body, filters[0], filter);
manifest = replaceMatch(manifest, activity, opening + body + activity[3]);
manifest = setUpdateFileProvider(manifest);

const generatedActivity = readFileSync(activityPath, "utf8");
const tvActivity = readFileSync(join(source, "MainActivity.kt"), "utf8");
// Only replace the known Tauri 2.10 template or our own previous patch. Fail
// explicitly if a future template adds behavior that needs to be retained.
const templateActivity = `package com.hghubx.tv
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}`;
const normalize = (text) => text.trim().replace(/\s+/g, " ");
const normalizedGenerated = normalize(generatedActivity);
const previousTvActivityHash = "f8320e5ebd8ee76776fad2b5752f09e4a4fa04f0630f6ef28e7d28663ef20c6f";
if (![templateActivity, tvActivity].some((expected) => normalize(expected) === normalizedGenerated) &&
    createHash("sha256").update(normalizedGenerated).digest("hex") !== previousTvActivityHash) {
  fail("MainActivity 与已知 Tauri 模板不同，请审阅原生改动后更新 TV patch");
}

// Everything above is parsed before writing any TV overrides. Generated files
// can always be restored by regenerating the Android project from its config.
cpSync(join(source, "res"), join(main, "res"), { recursive: true, force: true });
writeFileSync(manifestPath, manifest);
writeFileSync(activityPath, tvActivity);
console.log("[tv] HGhubX TV：独立包、Leanback 入口、应用内更新安装器、横屏 banner 与原生安全视口已写入");
