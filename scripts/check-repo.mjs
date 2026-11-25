#!/usr/bin/env node
// Fast, zero-dependency repository hygiene check:
// 1. Verifies synchronized versions across package.json, package-lock.json, src/version.ts,
//    Codex plugin manifest, and Claude Code plugin manifest.
// 2. Validates marketplace JSON files and referenced plugin paths.
// 3. Verifies every relative Markdown link resolves to an existing file in the repository.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];
const fail = msg => errors.push(msg);

const readJson = rel => {
  const full = join(root, rel);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    fail(`Invalid JSON in ${rel}: ${err.message}`);
    return null;
  }
};

// 1. Version synchronization
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const codexPlugin = readJson('plugins/lms-cli/.codex-plugin/plugin.json');
const claudePlugin = readJson('plugins/lms-cli-claude/.claude-plugin/plugin.json');
const versionTs = readFileSync(join(root, 'src/version.ts'), 'utf8');
const versionMatch = versionTs.match(/VERSION\s*=\s*['"]([^'"]+)['"]/);

if (!pkg?.version) fail('package.json missing version');
const expected = pkg?.version;
if (expected) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) fail(`package.json version is not valid SemVer: ${expected}`);
  if (lock?.version !== expected) fail(`package-lock.json version (${lock?.version}) != package.json (${expected})`);
  if (lock?.packages?.['']?.version !== expected) fail(`package-lock.json packages[""].version (${lock?.packages?.['']?.version}) != package.json (${expected})`);
  if (versionMatch?.[1] !== expected) fail(`src/version.ts VERSION (${versionMatch?.[1]}) != package.json (${expected})`);
  if (codexPlugin?.version !== expected) fail(`plugins/lms-cli/.codex-plugin/plugin.json version (${codexPlugin?.version}) != package.json (${expected})`);
  if (claudePlugin?.version !== expected) fail(`plugins/lms-cli-claude/.claude-plugin/plugin.json version (${claudePlugin?.version}) != package.json (${expected})`);
}

// 2. Marketplace manifests
for (const rel of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
  const manifest = readJson(rel);
  if (!manifest || !Array.isArray(manifest.plugins) || manifest.plugins.length === 0) {
    fail(`${rel}: missing or empty plugins array`);
    continue;
  }
  for (const entry of manifest.plugins) {
    const src = typeof entry.source === 'string' ? entry.source : entry.source?.path;
    if (!src) {
      fail(`${rel}: plugin entry ${entry.name ?? '(unnamed)'} missing source path`);
      continue;
    }
    const target = resolve(root, src);
    if (!existsSync(target)) fail(`${rel}: referenced plugin path does not exist: ${src}`);
  }
}

// 3. Relative Markdown links
function collectMarkdown(dir, results = []) {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', 'dist', 'release', 'release-cli', 'vendor'].includes(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collectMarkdown(full, results);
    else if (name.endsWith('.md')) results.push(full);
  }
  return results;
}

const mdFiles = collectMarkdown(root);
let checkedLinks = 0;

for (const file of mdFiles) {
  const relFile = relative(root, file);
  const raw = readFileSync(file, 'utf8');
  // Strip fenced code blocks and inline code spans before scanning links
  const stripped = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '');
  const linkRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of stripped.matchAll(linkRe)) {
    const href = match[1];
    if (!href || /^(?:https?:|mailto:|tel:|data:|#)/i.test(href)) continue;
    const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
    if (!clean) continue;
    checkedLinks++;
    const resolvedTarget = clean.startsWith('/') ? join(root, clean.slice(1)) : resolve(dirname(file), clean);
    if (!existsSync(resolvedTarget)) {
      fail(`${relFile}: broken relative link -> ${href}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Repository hygiene check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`Repository hygiene passed: version ${expected} synced across 6 files; ${checkedLinks} relative links verified across ${mdFiles.length} Markdown files.`);
