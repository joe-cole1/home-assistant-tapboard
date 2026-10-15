#!/bin/bash
# Prepares Claude Code cloud sessions (claude.ai/code): they start on an older Node, so activate
# Node 24 (package.json `engines`) and install the locked dependencies. Does nothing elsewhere.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none
}

if [ "$(node_major)" != "24" ]; then
  export NVM_DIR="${NVM_DIR:-/opt/nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "session-start: Node 24 is required, but nvm was not found in $NVM_DIR." >&2
    exit 1
  fi
  # nvm is not compatible with `set -eu`; check the result explicitly instead.
  set +eu
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use 24 >/dev/null 2>&1 || nvm install 24 >&2
  set -eu
  if [ "$(node_major)" != "24" ]; then
    echo "session-start: could not activate Node 24 with nvm." >&2
    exit 1
  fi
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$(dirname "$(command -v node)"):\$PATH\"" >>"$CLAUDE_ENV_FILE"
  # The preinstalled Chromium may not match the Playwright revision; see playwright.config.ts.
  if [ -x /opt/pw-browsers/chromium ]; then
    echo "export TAPBOARD_E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium" >>"$CLAUDE_ENV_FILE"
  fi
fi

# The container is cached after this hook, so reinstall only when Node or the lockfile changed.
stamp="node_modules/.session-start-stamp"
wanted="$(node -v) $(sha256sum package-lock.json | cut -d ' ' -f 1)"
if [ "$(cat "$stamp" 2>/dev/null || true)" != "$wanted" ]; then
  npm ci --no-audit --no-fund >&2
  echo "$wanted" >"$stamp"
fi

echo "Node $(node -v) and the locked npm dependencies are ready."
