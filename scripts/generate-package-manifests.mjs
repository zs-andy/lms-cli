#!/usr/bin/env node
/**
 * Generate verified Homebrew Formula, Scoop manifest, and Winget manifests
 * from a release version and SHA256SUMS.txt.
 *
 * Usage:
 *   node scripts/generate-package-manifests.mjs --version 0.4.7 --checksums SHA256SUMS.txt --out dist-manifests
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHECKSUM_LINE_RE = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9._-]+)$/;

export function validateVersion(version) {
  const clean = String(version ?? '').replace(/^v/, '');
  if (!SEMVER_RE.test(clean)) {
    throw new Error(`Invalid stable release version: "${version}". Expected X.Y.Z.`);
  }
  return clean;
}

export function validateRepo(repo) {
  if (!REPO_RE.test(repo)) {
    throw new Error(`Invalid GitHub repository slug: "${repo}". Expected owner/name.`);
  }
  return repo;
}

/** Parse SHA256SUMS.txt strictly: reject malformed lines or duplicate asset names. */
export function parseChecksums(text) {
  const map = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = CHECKSUM_LINE_RE.exec(line);
    if (!match) {
      throw new Error(`Invalid checksum line in SHA256SUMS.txt: "${line}"`);
    }
    const digest = match[1].toLowerCase();
    const filename = match[2];
    if (map.has(filename)) {
      throw new Error(`Duplicate checksum entry for "${filename}".`);
    }
    map.set(filename, digest);
  }
  return map;
}

function releaseUrl(repo, version, filename) {
  return `https://github.com/${repo}/releases/download/v${version}/${filename}`;
}

/**
 * Render a Homebrew Formula referencing verified standalone macOS & Linux tarballs.
 * Returns null if none of the macOS/Linux standalone tarballs are present.
 */
export function renderHomebrewFormula({ version, checksums, repo = 'zs-andy/lms-cli' }) {
  const cleanVersion = validateVersion(version);
  const cleanRepo = validateRepo(repo);
  const asset = (platform, arch) => {
    const name = `lms-cli-${cleanVersion}-${platform}-${arch}.tar.gz`;
    const sha256 = checksums.get(name);
    return sha256 ? { name, url: releaseUrl(cleanRepo, cleanVersion, name), sha256 } : null;
  };

  const darwinArm = asset('darwin', 'arm64');
  const darwinX64 = asset('darwin', 'x64');
  const linuxArm = asset('linux', 'arm64');
  const linuxX64 = asset('linux', 'x64');

  if (!darwinArm && !darwinX64 && !linuxArm && !linuxX64) return null;

  const lines = [
    '# typed: false',
    '# frozen_string_literal: true',
    '',
    'class LmsCli < Formula',
    '  desc "Multi-school Canvas, Blackboard & Moodle CLI and read-only MCP server"',
    `  homepage "https://github.com/${cleanRepo}"`,
    `  version "${cleanVersion}"`,
    '  license "MIT"',
    '',
  ];

  if (darwinArm || darwinX64) {
    lines.push('  on_macos do');
    if (darwinArm) {
      lines.push('    on_arm do');
      lines.push(`      url "${darwinArm.url}"`);
      lines.push(`      sha256 "${darwinArm.sha256}"`);
      lines.push('    end');
    }
    if (darwinX64) {
      lines.push('    on_intel do');
      lines.push(`      url "${darwinX64.url}"`);
      lines.push(`      sha256 "${darwinX64.sha256}"`);
      lines.push('    end');
    }
    lines.push('  end');
    lines.push('');
  }

  if (linuxArm || linuxX64) {
    lines.push('  on_linux do');
    if (linuxArm) {
      lines.push('    on_arm do');
      lines.push(`      url "${linuxArm.url}"`);
      lines.push(`      sha256 "${linuxArm.sha256}"`);
      lines.push('    end');
    }
    if (linuxX64) {
      lines.push('    on_intel do');
      lines.push(`      url "${linuxX64.url}"`);
      lines.push(`      sha256 "${linuxX64.sha256}"`);
      lines.push('    end');
    }
    lines.push('  end');
    lines.push('');
  }

  lines.push(
    '  def install',
    '    libexec.install "app", "runtime", "bundle.json"',
    '    (bin/"lms").write <<~SH',
    '      #!/bin/sh',
    '      export LMS_INSTALL_MANAGER="homebrew"',
    '      export LMS_INSTALL_LAUNCHER="#{opt_bin}/lms"',
    '      exec "#{libexec}/runtime/node" "#{libexec}/app/bin/lms.js" "$@"',
    '    SH',
    '  end',
    '',
    '  test do',
    '    assert_match version.to_s, shell_output("#{bin}/lms --version")',
    '    output = shell_output("#{bin}/lms doctor")',
    '    assert_match \'"installation": "homebrew"\', output',
    '  end',
    'end',
    '',
  );

  return lines.join('\n');
}

/**
 * Render a Scoop bucket manifest referencing verified Windows standalone tarballs.
 * Returns null if neither win32-x64 nor win32-arm64 standalone tarball is present.
 */
export function renderScoopManifest({ version, checksums, repo = 'zs-andy/lms-cli' }) {
  const cleanVersion = validateVersion(version);
  const cleanRepo = validateRepo(repo);
  const winX64Name = `lms-cli-${cleanVersion}-win32-x64.tar.gz`;
  const winArmName = `lms-cli-${cleanVersion}-win32-arm64.tar.gz`;
  const winX64 = checksums.get(winX64Name);
  const winArm = checksums.get(winArmName);

  if (!winX64 && !winArm) return null;

  const architecture = {};
  if (winX64) {
    architecture['64bit'] = {
      url: releaseUrl(cleanRepo, cleanVersion, winX64Name),
      hash: winX64,
    };
  }
  if (winArm) {
    architecture.arm64 = {
      url: releaseUrl(cleanRepo, cleanVersion, winArmName),
      hash: winArm,
    };
  }

  const manifest = {
    version: cleanVersion,
    description: 'Multi-school Canvas, Blackboard & Moodle CLI and read-only MCP server',
    homepage: `https://github.com/${cleanRepo}`,
    license: 'MIT',
    architecture,
    installer: {
      script: [
        '@(',
        '  "@echo off"',
        '  "set LMS_INSTALL_MANAGER=scoop"',
        '  "set LMS_INSTALL_LAUNCHER=%~f0"',
        '  "\\"%~dp0runtime\\\\node.exe\\" \\"%~dp0app\\\\bin\\\\lms.js\\" %*"',
        ') | Set-Content -Path "$dir\\lms.cmd" -Encoding ASCII',
      ],
    },
    bin: 'lms.cmd',
    checkver: 'github',
    autoupdate: {
      architecture: {
        ...(winX64
          ? {
              '64bit': {
                url: `https://github.com/${cleanRepo}/releases/download/v$version/lms-cli-$version-win32-x64.tar.gz`,
              },
            }
          : {}),
        ...(winArm
          ? {
              arm64: {
                url: `https://github.com/${cleanRepo}/releases/download/v$version/lms-cli-$version-win32-arm64.tar.gz`,
              },
            }
          : {}),
      },
      hash: {
        url: `https://github.com/${cleanRepo}/releases/download/v$version/SHA256SUMS.txt`,
      },
    },
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Render Winget v1.6.0 multi-file manifests referencing verified Windows installers
 * (`lms-cli-<ver>-x64.exe` / `lms-cli-<ver>-arm64.exe`).
 * Returns null if no Windows installer executable is present in SHA256SUMS.txt.
 */
export function renderWingetManifests({ version, checksums, repo = 'zs-andy/lms-cli', packageId = 'zs-andy.lms-cli' }) {
  const cleanVersion = validateVersion(version);
  const cleanRepo = validateRepo(repo);

  const installers = [];
  for (const [arch, suffix] of [
    ['x64', 'x64'],
    ['arm64', 'arm64'],
  ]) {
    const exeName = `lms-cli-${cleanVersion}-${suffix}.exe`;
    const sha = checksums.get(exeName);
    if (sha) {
      installers.push({
        arch,
        url: releaseUrl(cleanRepo, cleanVersion, exeName),
        sha256: sha.toUpperCase(),
      });
    }
  }

  if (installers.length === 0) return null;

  const versionYaml = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${cleanVersion}`,
    'DefaultLocale: en-US',
    'ManifestType: version',
    'ManifestVersion: 1.6.0',
    '',
  ].join('\n');

  const localeYaml = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${cleanVersion}`,
    'PackageLocale: en-US',
    'Publisher: LMS CLI contributors',
    `PublisherUrl: https://github.com/${cleanRepo}`,
    `PublisherSupportUrl: https://github.com/${cleanRepo}/issues`,
    'PackageName: lms-cli',
    `PackageUrl: https://github.com/${cleanRepo}`,
    'License: MIT',
    `LicenseUrl: https://github.com/${cleanRepo}/blob/v${cleanVersion}/LICENSE`,
    'ShortDescription: Multi-school Canvas, Blackboard & Moodle CLI and read-only MCP server',
    'Moniker: lms-cli',
    'Tags:',
    '  - canvas',
    '  - blackboard',
    '  - moodle',
    '  - lms',
    '  - mcp',
    '  - cli',
    `ReleaseNotesUrl: https://github.com/${cleanRepo}/releases/tag/v${cleanVersion}`,
    'ManifestType: defaultLocale',
    'ManifestVersion: 1.6.0',
    '',
  ].join('\n');

  const installerLines = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${cleanVersion}`,
    'InstallerType: nullsoft',
    'Scope: user',
    'InstallModes:',
    '  - interactive',
    '  - silent',
    '  - silentWithProgress',
    'UpgradeBehavior: install',
    'Installers:',
  ];

  for (const item of installers) {
    installerLines.push(
      `  - Architecture: ${item.arch}`,
      `    InstallerUrl: ${item.url}`,
      `    InstallerSha256: ${item.sha256}`,
    );
  }

  installerLines.push('ManifestType: installer', 'ManifestVersion: 1.6.0', '');

  return {
    [`${packageId}.yaml`]: versionYaml,
    [`${packageId}.locale.en-US.yaml`]: localeYaml,
    [`${packageId}.installer.yaml`]: installerLines.join('\n'),
  };
}

export async function generatePackageManifests({ version, checksumsText, outDir, repo = 'zs-andy/lms-cli' }) {
  const cleanVersion = validateVersion(version);
  const checksums = parseChecksums(checksumsText);
  const root = resolve(outDir);
  const written = [];

  const formula = renderHomebrewFormula({ version: cleanVersion, checksums, repo });
  if (formula) {
    const dir = join(root, 'homebrew', 'Formula');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'lms-cli.rb');
    await writeFile(file, formula, 'utf8');
    written.push(file);
  }

  const scoop = renderScoopManifest({ version: cleanVersion, checksums, repo });
  if (scoop) {
    const dir = join(root, 'scoop', 'bucket');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'lms-cli.json');
    await writeFile(file, scoop, 'utf8');
    written.push(file);
  }

  const winget = renderWingetManifests({ version: cleanVersion, checksums, repo });
  if (winget) {
    const dir = join(root, 'winget', 'manifests', 'z', 'zs-andy', 'lms-cli', cleanVersion);
    await mkdir(dir, { recursive: true });
    for (const [filename, content] of Object.entries(winget)) {
      const file = join(dir, filename);
      await writeFile(file, content, 'utf8');
      written.push(file);
    }
  }

  if (written.length === 0) {
    throw new Error('No matching standalone CLI or Windows installer assets were found in SHA256SUMS.txt.');
  }

  return written;
}

function parseCliArgs(argv) {
  const opts = { repo: 'zs-andy/lms-cli' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--version' && next) {
      opts.version = next;
      i++;
    } else if (flag === '--checksums' && next) {
      opts.checksums = next;
      i++;
    } else if (flag === '--out' && next) {
      opts.out = next;
      i++;
    } else if (flag === '--repo' && next) {
      opts.repo = next;
      i++;
    } else {
      throw new Error(`Unknown or incomplete option: ${flag}`);
    }
  }
  if (!opts.version || !opts.checksums || !opts.out) {
    throw new Error('Usage: node scripts/generate-package-manifests.mjs --version <X.Y.Z> --checksums <SHA256SUMS.txt> --out <dir>');
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const opts = parseCliArgs(process.argv.slice(2));
  const checksumsText = await readFile(opts.checksums, 'utf8');
  const files = await generatePackageManifests({
    version: opts.version,
    checksumsText,
    outDir: opts.out,
    repo: opts.repo,
  });
  console.log(`Generated ${files.length} package manager manifest file(s):`);
  for (const file of files) console.log(`  - ${file}`);
}
