#!/usr/bin/env node
// Verify that all tr()/N_() UI strings in standard edition exist in zh-TW and en dictionaries,
// with no missing/unused keys and matching {0}/{1} placeholder sets.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const srcDir = path.join(root, "src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function extractKeys() {
  const keys = new Set();
  const files = walk(srcDir).filter(
    (f) => !f.includes(`${path.sep}tv${path.sep}`) && !f.includes(`${path.sep}i18n${path.sep}locales${path.sep}`),
  );
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!/\b(?:tr|N_)\s*\(/.test(text)) continue;
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "tr" || node.expression.text === "N_") &&
        node.arguments.length >= 1
      ) {
        const first = node.arguments[0];
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
          keys.add(first.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...keys].sort();
}

function loadDict(rel) {
  const full = path.join(root, rel);
  const text = fs.readFileSync(full, "utf8");
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const map = new Map();
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const k = ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name) ? prop.name.text : null;
          const v =
            ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)
              ? prop.initializer.text
              : null;
          if (k !== null && v !== null) map.set(k, v);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

const placeholders = (s) => [...new Set([...s.matchAll(/\{\d+\}/g)].map((m) => m[0]))].sort().join(",");

const keys = extractKeys();
if (process.argv.includes("--dump-keys")) {
  process.stdout.write(JSON.stringify(keys, null, 2) + "\n");
  process.exit(0);
}

let failed = false;
for (const [name, rel] of [
  ["zh-TW", "src/shared/i18n/locales/zh-TW.ts"],
  ["en", "src/shared/i18n/locales/en.ts"],
]) {
  const dict = loadDict(rel);
  const missing = keys.filter((k) => !dict.has(k) || !dict.get(k));
  const extra = [...dict.keys()].filter((k) => !keys.includes(k));
  const badPlaceholders = keys.filter((k) => dict.has(k) && placeholders(k) !== placeholders(dict.get(k)));
  if (missing.length || extra.length || badPlaceholders.length) {
    failed = true;
    console.error(`i18n(${name}): missing=${missing.length}, extra=${extra.length}, placeholder_mismatch=${badPlaceholders.length}`);
    if (missing.length) console.error("  missing sample:", missing.slice(0, 10));
    if (extra.length) console.error("  extra sample:", extra.slice(0, 10));
    if (badPlaceholders.length) console.error("  placeholder mismatch sample:", badPlaceholders.slice(0, 10));
  }
}

if (failed) process.exit(1);
console.log(`i18n: ok ${keys.length} keys verified across zh-TW and en`);
