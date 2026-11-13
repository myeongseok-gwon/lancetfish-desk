#!/bin/zsh
# Finder entry point for the source alpha. Keep runtime data outside the bundle.
set -e
SCRIPT_DIR="${0:A:h}"
if [[ -f "$SCRIPT_DIR/server.mjs" ]]; then
  APP_DIR="$SCRIPT_DIR"
else
  APP_DIR="$SCRIPT_DIR/apps/v2"
fi
BUNDLE_ROOT="${APP_DIR:A:h:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
NODE_COMMAND="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_COMMAND" ]]; then
  print 'Install Node.js 25 or newer from https://nodejs.org/ and open this file again.'
  read -r '?Press Return to close.'
  exit 1
fi
NODE_MAJOR="$("$NODE_COMMAND" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 25 )); then
  print 'Lancetfish v2 needs Node.js 25 or newer. Set NODE_BIN if your newer Node is installed elsewhere.'
  read -r '?Press Return to close.'
  exit 1
fi
export LF_V2_DATA="${LF_V2_DATA:-$HOME/Library/Application Support/LancetfishV2}"
export PYTHONDONTWRITEBYTECODE=1
# A new source-alpha install starts with local history adapters off. Detection
# is visible in Settings; the user chooses which sources to enable before reads.
"$NODE_COMMAND" --input-type=module - "$LF_V2_DATA" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });
try {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ apps: {
    chatgpt: false, claude: false, claudeCode: false, codex: false,
    science: false, obsidian: false, anki: false,
  } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) { if (error.code !== 'EEXIST') throw error; }
JS
if [[ -x "$BUNDLE_ROOT/.venv/bin/python" ]]; then
  export V2_SLIDES_PYTHON="${V2_SLIDES_PYTHON:-$BUNDLE_ROOT/.venv/bin/python}"
  export LANCETFISH_PYTHON="${LANCETFISH_PYTHON:-$BUNDLE_ROOT/.venv/bin/python}"
fi
print "Local data: $LF_V2_DATA"
print "Dashboard: http://127.0.0.1:${PORT:-4848}/"
print 'Keep this window open. Press Control-C here to stop the server.'
# Open setup after Node has had time to bind its loopback listener.
(sleep 2; /usr/bin/open "http://127.0.0.1:${PORT:-4848}/settings") &
exec "$NODE_COMMAND" "$APP_DIR/server.mjs"
