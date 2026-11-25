#!/usr/bin/env node
// Synchronize release version across package.json, package-lock.json, src/version.ts,
// and both Codex / Claude Code plugin manifests.
// Usage: node scripts/bump-version.mjs 0.5.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: node scripts/bump-version.mjs <X.Y.Z>');
  process.exit(1);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function replaceFirstVersion(rel) {
  const full = join(root, rel);
  const before = readFileSync(full, 'utf8');
  const after = before.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`);
  if (before === after && !before.includes(`"version": "${next}"`)) {
    throw new Error(`Could not find version field in ${rel}`);
  }
  writeFileSync(full, after);
}

replaceFirstVersion('package.json');
replaceFirstVersion('plugins/lms-cli/.codex-plugin/plugin.json');
replaceFirstVersion('plugins/lms-cli-claude/.claude-plugin/plugin.json');

// Update package-lock.json top-level version and root package ("") version cleanly.
const lockPath = join(root, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

// Update src/version.ts
const versionPath = join(root, 'src/version.ts');
const versionBefore = readFileSync(versionPath, 'utf8');
const versionAfter = versionBefore.replace(/(VERSION\s*=\s*['"])[^'"]+(['"])/, `$1${next}$2`);
if (versionBefore === versionAfter && !versionBefore.includes(next)) {
  throw new Error('Could not find VERSION constant in src/version.ts');
}
writeFileSync(versionPath, versionAfter);

console.log(`Updated version to ${next} across package.json, package-lock.json, src/version.ts, Codex plugin, and Claude Code plugin.`);
console.log('Next steps:');
console.log(`  1. Update CHANGELOG.md and optional docs/releases/v${next}.md`);
console.log('  2. Run: npm run check:repo && npm run typecheck && npm test && npm audit --omit=dev');
console.log(`  3. Commit and tag v${next} to trigger the automated Draft Release workflow.`);
