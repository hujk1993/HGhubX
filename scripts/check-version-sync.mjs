#!/usr/bin/env node
// Release gates read different version fields.
// Standard builds keep package.json, tauri.conf.json, Cargo.toml and Cargo.lock on one version;
// TV builds maintain an independent version and bundle.android.versionCode in tauri.tv.conf.json.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let target = "all";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--target") {
    target = (args[++i] || "").trim();
  } else if (arg.startsWith("--target=")) {
    target = arg.slice("--target=".length).trim();
  }
}

if (!["all", "standard", "tv"].includes(target)) {
  console.error(`release-check: unsupported target "${target}" (expected all, standard, or tv).`);
  process.exit(1);
}

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function expectedVersionCode(version, label) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  if (!parsed) {
    console.error(`release-check: invalid ${label} version format "${version}".`);
    process.exit(1);
  }
  const [, major, minor, patch] = parsed.map(Number);
  if (minor > 999 || patch > 999) {
    console.error(`release-check: ${label} minor/patch exceeds 999 ("${version}").`);
    process.exit(1);
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

if (target === "all" || target === "standard") {
  const pkg = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml");
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? "";
  const lock = read("src-tauri/Cargo.lock");
  const hghubxBlock = lock.split("[[package]]").find((block) => /^\s*name\s*=\s*"hghubx"\s*$/m.test(block));
  const lockVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(hghubxBlock ?? "")?.[1] ?? "";

  const versions = {
    "package.json": pkg.version,
    "src-tauri/tauri.conf.json": tauri.version,
    "src-tauri/Cargo.toml": cargoVersion,
    "src-tauri/Cargo.lock (hghubx)": lockVersion,
  };
  for (const [file, version] of Object.entries(versions)) console.log(`${file}: ${version || "<missing>"}`);

  const unique = new Set(Object.values(versions));
  if (unique.size !== 1 || [...unique].some((value) => !value)) {
    console.error("release-check: version fields disagree; run scripts/set-version.mjs with the release version.");
    process.exit(1);
  }
  const versionCode = tauri.bundle?.android?.versionCode;
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    console.error("release-check: src-tauri/tauri.conf.json has no bundle.android.versionCode.");
    process.exit(1);
  }
  const expectedCode = expectedVersionCode(pkg.version, "standard");
  if (versionCode !== expectedCode) {
    console.error(`release-check: bundle.android.versionCode=${versionCode} does not match expected ${expectedCode} for ${pkg.version}; run scripts/set-version.mjs.`);
    process.exit(1);
  }
  console.log(`release-check: ok ${pkg.version}, android versionCode=${versionCode}`);
}

if (target === "all" || target === "tv") {
  const tv = JSON.parse(read("src-tauri/tauri.tv.conf.json"));
  const tvVersion = tv.version ?? "";
  const tvVersionCode = tv.bundle?.android?.versionCode;
  console.log(`src-tauri/tauri.tv.conf.json: ${tvVersion || "<missing>"}`);
  if (!tvVersion) {
    console.error("release-check(tv): src-tauri/tauri.tv.conf.json has no version; run scripts/set-version.mjs --target tv <version>.");
    process.exit(1);
  }
  if (!Number.isInteger(tvVersionCode) || tvVersionCode < 1) {
    console.error("release-check(tv): src-tauri/tauri.tv.conf.json has no bundle.android.versionCode.");
    process.exit(1);
  }
  const expectedTvCode = expectedVersionCode(tvVersion, "tv");
  if (tvVersionCode !== expectedTvCode) {
    console.error(`release-check(tv): bundle.android.versionCode=${tvVersionCode} does not match expected ${expectedTvCode} for ${tvVersion}; run scripts/set-version.mjs --target tv ${tvVersion}.`);
    process.exit(1);
  }
  console.log(`release-check(tv): ok ${tvVersion}, android versionCode=${tvVersionCode}`);
}
