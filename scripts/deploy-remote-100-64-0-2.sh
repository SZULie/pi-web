#!/usr/bin/env bash
set -euo pipefail

REMOTE=${REMOTE:-wap2wep@100.64.0.2}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_win}
REMOTE_DIR=${REMOTE_DIR:-/home/wap2wep/agy/pi-web}
REMOTE_SERVICE=${REMOTE_SERVICE:-pi-web.service}
BUILD_TIMEOUT=${BUILD_TIMEOUT:-900}
SSH_CONNECT_TIMEOUT=${SSH_CONNECT_TIMEOUT:-8}
SKIP_BUILD=${SKIP_BUILD:-0}

CURRENT_COMMIT=$(git -C "$(dirname "$0")/.." log -1 --oneline 2>/dev/null || true)

if ! ssh -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ConnectTimeout="$SSH_CONNECT_TIMEOUT" \
  -o ServerAliveInterval=3 \
  -o ServerAliveCountMax=1 \
  "$REMOTE" 'echo remote-ssh-ok' >/dev/null; then
  cat >&2 <<MSG
remote host $REMOTE is unreachable over SSH; deployment did not start.
local commit: ${CURRENT_COMMIT:-unknown}
retry when reachable:
  scripts/deploy-remote-100-64-0-2.sh
or for extension-only sync:
  SKIP_BUILD=1 scripts/deploy-remote-100-64-0-2.sh
MSG
  exit 70
fi

ssh -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ConnectTimeout="$SSH_CONNECT_TIMEOUT" \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=3 \
  "$REMOTE" wsl -d Ubuntu-24.04 bash -s -- "$REMOTE_DIR" "$REMOTE_SERVICE" "$BUILD_TIMEOUT" "$SKIP_BUILD" <<'EOF'
set -euo pipefail

REMOTE_DIR=$1
REMOTE_SERVICE=$2
BUILD_TIMEOUT=$3
SKIP_BUILD=$4

exec 9>/tmp/pi-web-custom-deploy.lock
if ! flock -n 9; then
  echo "another pi-web deployment is already running" >&2
  exit 75
fi

cd "$REMOTE_DIR"

diagnose() {
  local code=$?
  echo "--- deployment failed with exit code $code" >&2
  echo "--- running build processes" >&2
  pgrep -af 'next build|npm run build|node.*next' >&2 || true
  echo "--- service state" >&2
  systemctl --user is-active "$REMOTE_SERVICE" >&2 || true
  curl -s -o /dev/null -w 'remote HTTP during failure: %{http_code}\n' http://127.0.0.1:8504/ >&2 || true
  exit "$code"
}
trap diagnose ERR

git fetch origin custom
git reset --hard origin/custom
mkdir -p "$HOME/.pi/agent/extensions/pi-goal-runner"
cp extensions/pi-goal-runner/index.ts "$HOME/.pi/agent/extensions/pi-goal-runner/index.ts"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi
node -v
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) { console.error("Node >=20 required, got " + process.version); process.exit(1); }'

install_dependencies() {
  npm install --prefer-offline --no-audit --no-fund
}
install_dependencies || { sleep 5; install_dependencies; } || { sleep 15; npm install --no-audit --no-fund; }

if [ "$SKIP_BUILD" = "1" ]; then
  echo "SKIP_BUILD=1: skipping Next.js build"
else
  timeout --kill-after=30s "$BUILD_TIMEOUT" npm run build
fi
systemctl --user restart "$REMOTE_SERVICE"
systemctl --user is-active "$REMOTE_SERVICE"
curl -s -o /dev/null -w 'remote HTTP: %{http_code}\n' http://127.0.0.1:8504/
cmp -s extensions/pi-goal-runner/index.ts "$HOME/.pi/agent/extensions/pi-goal-runner/index.ts" && echo remote-extension-installed-matches
git log -1 --oneline
EOF
