#!/usr/bin/env bash
set -euo pipefail

# Review-only candidate for the independent Liar's Tavern service.
#
# This file is intentionally not invoked by the current task. It is blocked
# until the release manifest is frozen and an explicit per-release confirmation
# token is supplied. All remote mutations stay behind deploy-lock-lib.sh.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO_ROOT="${LIARS_TAVERN_REPO_ROOT:-$(cd "$ROOT/../.." && pwd)}"
LOCK_LIB="${LIARS_TAVERN_LOCK_LIB:-$REPO_ROOT/scripts/deploy-lock-lib.sh}"
DEPLOY_PROXY="${LIARS_TAVERN_DEPLOY_PROXY:-$REPO_ROOT/ops/ssh-preread-proxy.py}"
DEPLOY_HOST="${LIARS_TAVERN_DEPLOY_HOST:-62.146.180.177}"
DEPLOY_PORT="${LIARS_TAVERN_DEPLOY_PORT:-38222}"
DEPLOY_USER="${LIARS_TAVERN_DEPLOY_USER:-root}"
DEPLOY_KEY="${LIARS_TAVERN_DEPLOY_KEY:-$HOME/.ssh/aevi_contabo_ed25519}"

REMOTE_BASE="/opt/liars-tavern"
REMOTE_INCOMING="/opt/liars-tavern-incoming"
REMOTE_SERVICE="liars-tavern.service"
REMOTE_UNIT="/etc/systemd/system/$REMOTE_SERVICE"
REMOTE_CADDY="/etc/caddy/Caddyfile"
REMOTE_HOST="aurexaevi.xyz"
REMOTE_PORT="3279"
MANIFEST="$ROOT/ops/release-manifest.json"
CONFIRMATION="${LIARS_TAVERN_DEPLOY_CONFIRM:-}"

[[ "$CONFIRMATION" == "I_CONFIRM_LIARS_TAVERN_V1" ]] || {
  echo "部署候选已锁定：需本次明确确认后设置 LIARS_TAVERN_DEPLOY_CONFIRM=I_CONFIRM_LIARS_TAVERN_V1" >&2
  exit 1
}
[[ "${AEVI_LOCK_BREAK:-0}" != "1" ]] || {
  echo "本候选不接受 AEVI_LOCK_BREAK=1；锁被占用时必须等待或停手。" >&2
  exit 1
}
[[ -f "$MANIFEST" ]] || { echo "缺少 manifest:$MANIFEST" >&2; exit 1; }
[[ -f "$LOCK_LIB" ]] || { echo "缺少部署锁库:$LOCK_LIB" >&2; exit 1; }
[[ -x "$DEPLOY_PROXY" ]] || { echo "缺少可执行 SSH 预读代理:$DEPLOY_PROXY" >&2; exit 1; }

for command_name in node npm ssh rsync tar shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "本机缺少依赖:$command_name" >&2
    exit 1
  }
done

MANIFEST_STATUS="$(node --input-type=module - "$MANIFEST" <<'NODE'
import fs from 'node:fs';
const [, , manifestPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
process.stdout.write(`${manifest.status || ''}\t${manifest.releaseId || ''}`);
NODE
)"
MANIFEST_STATUS_VALUE="${MANIFEST_STATUS%%$'\t'*}"
RELEASE_ID="${MANIFEST_STATUS#*$'\t'}"
[[ "$MANIFEST_STATUS_VALUE" == "frozen" ]] || {
  echo "manifest 当前不是 frozen，暂不允许部署:$MANIFEST_STATUS_VALUE" >&2
  exit 1
}
[[ "$RELEASE_ID" =~ ^liars-tavern-[0-9]{8}-v[0-9]+$ ]] || {
  echo "releaseId 不是冻结版本:$RELEASE_ID" >&2
  exit 1
}

LOCAL_PACKAGE_DIR="$(mktemp -d -t liars-tavern-package.XXXXXX)"
SSH_CONFIG_PATH="$(mktemp -t liars-tavern-ssh.XXXXXX)"
REMOTE_STAGE="$REMOTE_INCOMING/$RELEASE_ID"
LOCK_HELD=0

{
  printf 'Host liars-tavern-deploy\n'
  printf '  HostName %s\n' "$DEPLOY_HOST"
  printf '  User %s\n' "$DEPLOY_USER"
  printf '  Port %s\n' "$DEPLOY_PORT"
  printf '  IdentityFile %s\n' "$DEPLOY_KEY"
  printf '  BatchMode yes\n'
  printf '  StrictHostKeyChecking accept-new\n'
  printf '  ServerAliveInterval 15\n'
  printf '  ServerAliveCountMax 4\n'
  printf '  LogLevel ERROR\n'
  printf '  ProxyCommand %s %%h %%p\n' "$DEPLOY_PROXY"
} >"$SSH_CONFIG_PATH"

remote_shell() {
  ssh -F "$SSH_CONFIG_PATH" liars-tavern-deploy "$@"
}

cleanup() {
  local status=$?
  set +e
  if [[ "$LOCK_HELD" == "1" ]]; then
    remote_shell "sudo -n rm -rf '$REMOTE_STAGE'" >/dev/null 2>&1 || true
    aevi_deploy_lock_release remote_shell || true
  fi
  rm -f "$SSH_CONFIG_PATH"
  rm -rf "$LOCAL_PACKAGE_DIR"
  exit "$status"
}
trap cleanup EXIT

source "$LOCK_LIB"

echo "== 本地冻结检查和打包 =="
LIARS_PACKAGE_OUT="$LOCAL_PACKAGE_DIR" "$ROOT/ops/package-release.sh"
ARTIFACT="$LOCAL_PACKAGE_DIR/${RELEASE_ID}.tar.gz"
ARTIFACT_SHA="$ARTIFACT.sha256"
test -s "$ARTIFACT"
test -s "$ARTIFACT_SHA"

echo "== 获取共享部署锁并进行 VPS 只读预检 =="
aevi_deploy_lock_acquire remote_shell "liars-tavern:${RELEASE_ID}"
LOCK_HELD=1

BASELINE="$(remote_shell "sudo -n sh -s" <<'REMOTE'
set -eu
test -x /usr/bin/node
test "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" = 22
command -v npm >/dev/null
command -v caddy >/dev/null
command -v curl >/dev/null
command -v rsync >/dev/null
command -v ss >/dev/null
command -v sha256sum >/dev/null
command -v python3 >/dev/null
systemctl is-active --quiet caddy
systemctl is-active --quiet aevi-home.service
if ss -ltn | awk '$4 ~ /(^|:)3279$/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo '3279 已被占用' >&2
  exit 1
fi
printf 'pid=%s restarts=%s\n' \
  "$(systemctl show -p MainPID --value aevi-home.service)" \
  "$(systemctl show -p NRestarts --value aevi-home.service)"
REMOTE
)"
AEVI_PID_BEFORE="$(printf '%s\n' "$BASELINE" | sed -n 's/^pid=//p' | cut -d' ' -f1)"
AEVI_RESTARTS_BEFORE="$(printf '%s\n' "$BASELINE" | sed -n 's/^pid=[0-9][0-9]* restarts=//p')"
[[ "$AEVI_PID_BEFORE" =~ ^[0-9]+$ ]] || { echo "读不到 Aevi MainPID" >&2; exit 1; }
[[ "$AEVI_RESTARTS_BEFORE" =~ ^[0-9]+$ ]] || { echo "读不到 Aevi NRestarts" >&2; exit 1; }

echo "== 上传固定 artifact 到隔离暂存区 =="
remote_shell "sudo -n rm -rf '$REMOTE_STAGE' && sudo -n mkdir -p '$REMOTE_STAGE'"
rsync -az --rsync-path="sudo -n rsync" -e "ssh -F $SSH_CONFIG_PATH" \
  "$ARTIFACT" "$ARTIFACT_SHA" "liars-tavern-deploy:$REMOTE_STAGE/"

echo "== 远端校验、原子提升、systemd/Caddy 验收 =="
remote_shell "sudo -n env \
  RELEASE_ID='$RELEASE_ID' \
  REMOTE_BASE='$REMOTE_BASE' \
  REMOTE_STAGE='$REMOTE_STAGE' \
  REMOTE_UNIT='$REMOTE_UNIT' \
  REMOTE_CADDY='$REMOTE_CADDY' \
  AEVI_PID_BEFORE='$AEVI_PID_BEFORE' \
  AEVI_RESTARTS_BEFORE='$AEVI_RESTARTS_BEFORE' \
  sh -s" <<'REMOTE'
set -eu

SERVICE='liars-tavern.service'
SERVICE_USER='liars-tavern'
BACKUP_DIR="/var/backups/aevi/liars-tavern-${RELEASE_ID}"
CURRENT="$REMOTE_BASE/current"
RELEASE_DIR="$REMOTE_BASE/releases/$RELEASE_ID"
ARTIFACT="$REMOTE_STAGE/${RELEASE_ID}.tar.gz"
ARTIFACT_SHA="$ARTIFACT.sha256"
EXTRACT_DIR="$REMOTE_STAGE/extracted"
UNIT_BACKUP="$BACKUP_DIR/$SERVICE"
CADDY_BACKUP="$BACKUP_DIR/Caddyfile"
CADDY_NEXT="$REMOTE_CADDY.liars-tavern-${RELEASE_ID}.incoming"
CADDY_INSTALL_NEXT="$REMOTE_CADDY.liars-tavern-${RELEASE_ID}.next"
OLD_CURRENT=''
OLD_UNIT=0
OLD_ACTIVE='inactive'
OLD_ENABLED='disabled'
PROMOTED=0
CADDY_CHANGED=0

rollback() {
  status=$?
  if [ "$status" -eq 0 ]; then
    return
  fi
  set +e
  echo "Liar's Tavern 发布失败，开始隔离回滚。" >&2
  rm -f "$CADDY_NEXT" "$CADDY_INSTALL_NEXT"
  if [ "$CADDY_CHANGED" = 1 ] && [ -f "$CADDY_BACKUP" ]; then
    cp -a "$CADDY_BACKUP" "$REMOTE_CADDY"
    caddy validate --config "$REMOTE_CADDY" --adapter caddyfile >/dev/null || true
    systemctl reload caddy || true
  fi
  if [ "$PROMOTED" = 1 ]; then
    systemctl stop "$SERVICE" || true
    if [ -n "$OLD_CURRENT" ]; then
      ln -sfn "$OLD_CURRENT" "$CURRENT.rollback"
      mv -Tf "$CURRENT.rollback" "$CURRENT"
    else
      rm -f "$CURRENT"
    fi
    if [ "$OLD_UNIT" = 1 ] && [ -f "$UNIT_BACKUP" ]; then
      cp -a "$UNIT_BACKUP" "$REMOTE_UNIT"
    else
      rm -f "$REMOTE_UNIT"
    fi
    systemctl daemon-reload || true
    if [ "$OLD_UNIT" = 1 ] && [ "$OLD_ACTIVE" = active ]; then
      systemctl restart "$SERVICE" || true
    else
      systemctl stop "$SERVICE" || true
    fi
    if [ "$OLD_ENABLED" = enabled ]; then
      systemctl enable "$SERVICE" >/dev/null 2>&1 || true
    else
      systemctl disable "$SERVICE" >/dev/null 2>&1 || true
    fi
    rm -rf "$RELEASE_DIR"
  fi
  echo "回滚完成；/opt/aevi-home 与 aevi-home.service 未被回滚逻辑触碰。" >&2
  exit "$status"
}
trap rollback EXIT

test -s "$ARTIFACT"
test -s "$ARTIFACT_SHA"
EXPECTED_SHA="$(awk 'NR == 1 { print $1 }' "$ARTIFACT_SHA")"
ACTUAL_SHA="$(sha256sum "$ARTIFACT" | awk '{ print $1 }')"
test -n "$EXPECTED_SHA" && test "$EXPECTED_SHA" = "$ACTUAL_SHA"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARTIFACT" -C "$EXTRACT_DIR"
test -f "$EXTRACT_DIR/ops/release-manifest.json"
test -f "$EXTRACT_DIR/ops/systemd/liars-tavern.service"
test -f "$EXTRACT_DIR/ops/caddy/aurexaevi.xyz.tavern.caddy"
test "$(node --input-type=module - "$EXTRACT_DIR/ops/release-manifest.json" <<'NODE'
import fs from 'node:fs';
const [, , manifestPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.status !== 'frozen' || manifest.releaseId !== process.env.RELEASE_ID) process.exit(1);
process.stdout.write('ok');
NODE
)" = ok

cd "$EXTRACT_DIR"
npm ci --omit=dev --no-audit --no-fund
node --check server.js
node --check game.js
node --check ai.js
node --check bot.js
cd /

mkdir -p "$BACKUP_DIR" "$REMOTE_BASE/releases"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$REMOTE_BASE" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o root -g root -m 0755 "$REMOTE_BASE" "$REMOTE_BASE/releases"
if [ -e "$CURRENT" ]; then
  OLD_CURRENT="$(readlink "$CURRENT")"
  tar -czf "$BACKUP_DIR/current-link.tgz" -C "$REMOTE_BASE" current
  chmod 600 "$BACKUP_DIR/current-link.tgz"
fi
if [ -f "$REMOTE_UNIT" ]; then
  OLD_UNIT=1
  cp -a "$REMOTE_UNIT" "$UNIT_BACKUP"
  chmod 600 "$UNIT_BACKUP"
fi
OLD_ACTIVE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
OLD_ENABLED="$(systemctl is-enabled "$SERVICE" 2>/dev/null || true)"
cp -a "$REMOTE_CADDY" "$CADDY_BACKUP"
chmod 600 "$CADDY_BACKUP"

test ! -e "$RELEASE_DIR"
mv "$EXTRACT_DIR" "$RELEASE_DIR"
PROMOTED=1
ln -s "$RELEASE_DIR" "$CURRENT.next"
mv -Tf "$CURRENT.next" "$CURRENT"
install -o root -g root -m 0644 "$CURRENT/ops/systemd/liars-tavern.service" "$REMOTE_UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
systemctl is-active --quiet "$SERVICE"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3279/health | grep -q '"service":"liars-tavern"'; then
    break
  fi
  if [ "$attempt" = 30 ]; then
    echo "Liar's Tavern 本机 health 未就绪" >&2
    exit 1
  fi
  sleep 1
done

PATCH_STATE="$(python3 - "$REMOTE_CADDY" "$CADDY_NEXT" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1])
candidate = Path(sys.argv[2])
text = source.read_text(encoding='utf-8')
start = '  # >>> liars-tavern\n'
end = '  # <<< liars-tavern\n'
block = '''  # >>> liars-tavern
  redir /tavern /tavern/ 308
  handle_path /tavern/* {
    reverse_proxy 127.0.0.1:3279
  }
  # <<< liars-tavern
'''
begin = text.find(start)
finish = text.find(end, begin + len(start)) if begin >= 0 else -1
if begin >= 0 and finish >= 0:
    finish += len(end)
    existing = text[begin:finish]
    if existing != block:
        raise SystemExit('已有 liars-tavern Caddy 标记但内容不一致，停止')
    candidate.write_text(text, encoding='utf-8')
    print('unchanged')
elif begin >= 0 or finish >= 0:
    raise SystemExit('liars-tavern Caddy 标记不完整，停止')
else:
    anchor = 'aurexaevi.xyz, www.aurexaevi.xyz {\n'
    if text.count(anchor) != 1:
        raise SystemExit('找不到唯一 aurexaevi.xyz 主站点块，停止')
    candidate.write_text(text.replace(anchor, anchor + block, 1), encoding='utf-8')
    print('changed')
PY
)"
if [ "$PATCH_STATE" = changed ]; then CADDY_CHANGED=1; fi
caddy validate --config "$CADDY_NEXT" --adapter caddyfile >/dev/null
if [ "$CADDY_CHANGED" = 1 ]; then
  install -o root -g root -m 0644 "$CADDY_NEXT" "$CADDY_INSTALL_NEXT"
  mv -Tf "$CADDY_INSTALL_NEXT" "$REMOTE_CADDY"
  systemctl reload caddy
fi
rm -f "$CADDY_NEXT" "$CADDY_INSTALL_NEXT"
systemctl is-active --quiet caddy

test "$(systemctl show -p MainPID --value aevi-home.service)" = "$AEVI_PID_BEFORE"
test "$(systemctl show -p NRestarts --value aevi-home.service)" = "$AEVI_RESTARTS_BEFORE"
systemctl is-active --quiet aevi-home.service
curl -fsS https://aurexaevi.xyz/health | grep -q '"ok":true'
curl -fsS --resolve aurexaevi.xyz:443:127.0.0.1 https://aurexaevi.xyz/tavern/ | grep -q 'Liar'
curl -fsS --resolve aurexaevi.xyz:443:127.0.0.1 \
  'https://aurexaevi.xyz/tavern/socket.io/?EIO=4&transport=polling' | grep -q 'sid'

mkdir -p /var/log
printf '%s release=%s service=%s port=%s aevi_pid=%s aevi_restarts=%s\n' \
  "$(date -u +%FT%TZ)" "$RELEASE_ID" "$SERVICE" 3279 \
  "$AEVI_PID_BEFORE" "$AEVI_RESTARTS_BEFORE" >>/var/log/liars-tavern-deploy.log
trap - EXIT
rm -rf "$REMOTE_STAGE"
echo "Liar's Tavern deployment candidate passed: $RELEASE_ID"
REMOTE

echo "部署候选完成；本脚本没有触碰 /opt/aevi-home 的文件或服务。"
