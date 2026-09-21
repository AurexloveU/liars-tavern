#!/usr/bin/env bash
set -euo pipefail

# Local-only packager. It does not SSH, rsync, touch /opt, install systemd,
# edit Caddy, or start a service. A release can be promoted only after the
# separate deployment review and the user's explicit confirmation.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MANIFEST="$ROOT/ops/release-manifest.json"
OUT_DIR="${LIARS_PACKAGE_OUT:-$ROOT/ops/dist}"
SKIP_TESTS="${LIARS_PACKAGE_SKIP_TESTS:-0}"

[[ -f "$MANIFEST" ]] || { echo "missing release manifest: $MANIFEST" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "shasum is required" >&2; exit 1; }

if [[ "$SKIP_TESTS" != "1" ]]; then
  npm run check
  node --check bot.js
  npm test
fi

CHECK_LIST="$(mktemp -t liars-tavern-release-files.XXXXXX)"
STAGE_DIR="$(mktemp -d -t liars-tavern-release.XXXXXX)"
cleanup() {
  rm -f "$CHECK_LIST"
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

node --input-type=module - "$ROOT" "$MANIFEST" >"$CHECK_LIST" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [, , root, manifestPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1) throw new Error('unsupported manifest schema');
if (manifest.status !== 'frozen') throw new Error('manifest is not frozen');
if (!/-v[0-9]+$/.test(manifest.releaseId)) throw new Error('releaseId is not a frozen version');
if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.releaseId)) throw new Error('invalid releaseId');
if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('manifest files missing');
const seen = new Set();
for (const entry of manifest.files) {
  const rel = entry?.path;
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`invalid manifest path: ${rel}`);
  }
  if (seen.has(rel)) throw new Error(`duplicate manifest path: ${rel}`);
  seen.add(rel);
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`invalid sha256: ${rel}`);
  const full = path.join(root, rel);
  if (!fs.statSync(full).isFile()) throw new Error(`manifest file missing: ${rel}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  if (actual !== entry.sha256) throw new Error(`sha256 mismatch: ${rel}`);
  process.stdout.write(`${rel}\t${entry.sha256}\n`);
}
NODE

RELEASE_ID="$(node --input-type=module - "$MANIFEST" <<'NODE'
import fs from 'node:fs';
const [, , manifestPath] = process.argv;
process.stdout.write(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).releaseId);
NODE
)"
ARTIFACT="$OUT_DIR/${RELEASE_ID}.tar.gz"
[[ ! -e "$ARTIFACT" && ! -e "$ARTIFACT.sha256" ]] || {
  echo "release artifact already exists: $ARTIFACT" >&2
  exit 1
}

while IFS=$'\t' read -r rel _sha; do
  [[ -n "$rel" ]] || continue
  mkdir -p "$STAGE_DIR/$(dirname "$rel")"
  cp -p "$ROOT/$rel" "$STAGE_DIR/$rel"
done <"$CHECK_LIST"
mkdir -p "$STAGE_DIR/ops"
cp -p "$MANIFEST" "$STAGE_DIR/ops/release-manifest.json"

mkdir -p "$OUT_DIR"
tar -C "$STAGE_DIR" -czf "$ARTIFACT" .
printf '%s  %s\n' \
  "$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')" \
  "$(basename "$ARTIFACT")" >"$ARTIFACT.sha256"
printf 'release=%s\nartifact=%s\nsha256=%s\n' \
  "$RELEASE_ID" "$ARTIFACT" "$(awk '{print $1}' "$ARTIFACT.sha256")"
