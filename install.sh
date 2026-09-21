#!/bin/sh
# CLI-only installer. Downloads from this repository, verifies SHA-256, then switches an immutable version.
set -eu
fail() { printf 'lms install: %s\n' "$*" >&2; exit 1; }
lms_root="${HOME}/.local/share/lms-cli-runtime"
lms_version=''; lms_archive=''; lms_sums=''; lms_setup=1; lms_path=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail 'Missing version'; lms_version=$2; shift 2 ;;
    --dir) [ "$#" -ge 2 ] || fail 'Missing directory'; lms_root=$2; shift 2 ;;
    --archive) [ "$#" -ge 2 ] || fail 'Missing archive'; lms_archive=$2; shift 2 ;;
    --checksum-file) [ "$#" -ge 2 ] || fail 'Missing checksum file'; lms_sums=$2; shift 2 ;;
    --no-setup) lms_setup=0; shift ;;
    --no-path) lms_path=0; shift ;;
    --help) printf '%s\n' 'install.sh [--version vX.Y.Z] [--no-setup] [--no-path] [--dir PATH]' 'Offline: --archive FILE --checksum-file FILE --version vX.Y.Z'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$lms_root" in /*) ;; *) fail 'Install directory must be absolute.' ;; esac
[ "$lms_root" != / ] && [ "$lms_root" != "$HOME" ] && [ ! -L "$lms_root" ] || fail 'Unsafe install directory.'
case "$(uname -s)" in Darwin) lms_os=darwin ;; Linux) lms_os=linux ;; *) fail 'Use install.ps1 on Windows.' ;; esac
case "$(uname -m)" in arm64|aarch64) lms_arch=arm64 ;; x86_64|amd64) lms_arch=x64 ;; *) fail 'Unsupported CPU architecture.' ;; esac
command -v tar >/dev/null 2>&1 || fail 'tar is required.'
if command -v shasum >/dev/null 2>&1; then lms_hash=shasum; elif command -v sha256sum >/dev/null 2>&1; then lms_hash=sha256sum; else fail 'SHA-256 tool is required.'; fi
lms_fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 "$1" -o "$2"; }
if [ -z "$lms_archive" ]; then
  command -v curl >/dev/null 2>&1 || fail 'curl is required.'
  if [ -z "$lms_version" ]; then
    lms_version=$(curl --fail --silent --show-error --proto '=https' --max-time 20 https://api.github.com/repos/zs-andy/lms-cli/releases/latest | sed -n 's/^[[:space:]]*"tag_name": "\(v[0-9][0-9.]*\)",*[[:space:]]*$/\1/p')
  fi
else
  [ -n "$lms_version" ] && [ -f "$lms_archive" ] && [ -f "$lms_sums" ] || fail 'Offline install requires an archive, checksum file and version.'
fi
printf '%s\n' "$lms_version" | LC_ALL=C grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || fail 'No valid stable release found. No development or unrelated npm package will be installed.'
lms_name="lms-cli-${lms_version#v}-${lms_os}-${lms_arch}.tar.gz"
if [ -e "$lms_root" ]; then
  [ -f "$lms_root/.lms-install" ] && [ "$(cat "$lms_root/.lms-install")" = lms-cli-managed-v1 ] || fail 'Directory is not managed by lms-cli; refusing to overwrite it.'
else
  mkdir -p "$lms_root"
  printf '%s\n' lms-cli-managed-v1 > "$lms_root/.lms-install"
fi
mkdir "$lms_root.lock" 2>/dev/null || fail 'Another installer/updater is running. Retry after it finishes.'
lms_stage=$(mktemp -d "$lms_root/.install-XXXXXX")
lms_cleanup() { if [ -n "${lms_stage:-}" ] && [ -d "$lms_stage" ]; then rm -rf -- "$lms_stage"; fi; rmdir "$lms_root.lock" 2>/dev/null || true; }
trap lms_cleanup EXIT HUP INT TERM
if [ -z "$lms_archive" ]; then
  lms_url="https://github.com/zs-andy/lms-cli/releases/download/$lms_version"
  lms_fetch "$lms_url/SHA256SUMS.txt" "$lms_stage/SHA256SUMS.txt" || fail 'This release has no verified CLI bundle yet.'
  lms_fetch "$lms_url/$lms_name" "$lms_stage/package.tar.gz" || fail 'No CLI bundle is published for this OS/architecture.'
  lms_archive=$lms_stage/package.tar.gz; lms_sums=$lms_stage/SHA256SUMS.txt
fi
lms_expected=$(awk -v name="$lms_name" '$2 == name { print $1 }' "$lms_sums")
printf '%s\n' "$lms_expected" | LC_ALL=C grep -Eq '^[a-fA-F0-9]{64}$' || fail 'Missing or ambiguous SHA-256 checksum.'
if [ "$lms_hash" = shasum ]; then lms_actual=$(shasum -a 256 "$lms_archive" | awk '{print $1}'); else lms_actual=$(sha256sum "$lms_archive" | awk '{print $1}'); fi
[ "$lms_actual" = "$lms_expected" ] || fail 'Checksum mismatch; existing version unchanged.'
tar -tzf "$lms_archive" > "$lms_stage/entries"
awk 'BEGIN{ok=1} /^\// || /\\/ || /(^|\/)\.\.(\/|$)/ || !/^(app\/|runtime\/|launchers\/|bundle\.json$)/ {ok=0} END{exit !ok}' "$lms_stage/entries" || fail 'Unsafe archive paths.'
tar -tvzf "$lms_archive" > "$lms_stage/types"
awk 'substr($0,1,1)=="l" {i=index($0," -> "); target=substr($0,i+4); if(!i || target ~ /(^\/|\\|:|(^|\/)\.\.(\/|$))/) bad=1; next} substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END{exit bad}' "$lms_stage/types" || fail 'Archive contains unsafe links or special files.'
mkdir "$lms_stage/unpack" "$lms_stage/check-home"
tar -xzf "$lms_archive" -C "$lms_stage/unpack"
lms_payload=$lms_stage/unpack
# A repeated install reuses an immutable version, so validate the runtime that will actually run.
if [ -e "$lms_root/versions/$lms_version" ]; then lms_payload=$lms_root/versions/$lms_version; fi
[ "$(LMS_UPDATE_CHECK=0 "$lms_payload/runtime/node" "$lms_payload/app/bin/lms.js" --version)" = "${lms_version#v}" ] || fail 'Bundle version does not match the release.'
LMS_HOME="$lms_stage/check-home" LMS_UPDATE_CHECK=0 "$lms_payload/runtime/node" "$lms_payload/app/bin/lms.js" doctor > "$lms_stage/doctor.json" || fail 'Bundled CLI failed its launch check.'
grep -Eq '"nativeKeyringModuleLoads": true' "$lms_stage/doctor.json" || fail 'Native credential module cannot load on this system.'
grep -Eq '"authorizationRuntimeInstalled": true' "$lms_stage/doctor.json" || fail 'Authorization runtime is missing; refusing an incomplete bundle.'
mkdir -p "$lms_root/versions" "$lms_root/bin"
if [ ! -e "$lms_root/versions/$lms_version" ]; then mv "$lms_payload" "$lms_root/versions/$lms_version"; fi
cp "$lms_root/versions/$lms_version/launchers/lms" "$lms_root/bin/lms"
chmod 755 "$lms_root/bin/lms"
if [ -f "$lms_root/current" ] && [ "$(cat "$lms_root/current")" != "$lms_version" ]; then cp "$lms_root/current" "$lms_root/previous"; fi
printf '%s\n' "$lms_version" > "$lms_stage/current"
mv "$lms_stage/current" "$lms_root/current"
if [ "$lms_path" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  if [ ! -e "$HOME/.local/bin/lms" ] && [ ! -L "$HOME/.local/bin/lms" ]; then ln -s "$lms_root/bin/lms" "$HOME/.local/bin/lms";
  elif [ "$(readlink "$HOME/.local/bin/lms" 2>/dev/null || true)" != "$lms_root/bin/lms" ]; then printf '%s\n' 'Existing ~/.local/bin/lms preserved. Use the full path below or resolve the name conflict.' >&2; fi
  case ":${PATH:-}:" in *":$HOME/.local/bin:"*) ;; *)
    case "${SHELL:-}" in */zsh) lms_rc=$HOME/.zshrc ;; */bash) lms_rc=$HOME/.bashrc ;; *) lms_rc=$HOME/.profile ;; esac
    if ! grep -Fq '# lms-cli PATH' "$lms_rc" 2>/dev/null; then
      [ ! -f "$lms_rc" ] || cp -p "$lms_rc" "$lms_rc.lms-backup-$(date +%Y%m%d%H%M%S)"
      printf '\n%s\n%s\n' '# lms-cli PATH (remove this block to undo)' 'export PATH="$HOME/.local/bin:$PATH"' >> "$lms_rc"
    fi
    printf '%s\n' 'Open a new terminal to use lms directly.' ;;
  esac
fi
printf 'Installed lms-cli %s. CLI: %s\n' "${lms_version#v}" "$lms_root/bin/lms"
lms_cleanup; trap - EXIT HUP INT TERM
if [ "$lms_setup" = 1 ] && [ -t 1 ] && [ -r /dev/tty ]; then "$lms_root/bin/lms" setup < /dev/tty;
else printf 'Next: "%s" setup\n' "$lms_root/bin/lms"; fi
