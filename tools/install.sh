#!/bin/sh
# Starts MagicMirror Manager with pm2 next to an existing MagicMirror installation.
# Usage: sh tools/install.sh   (optional: MM_DIR=… PORT=… sh tools/install.sh)
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
MM_DIR="${MM_DIR:-$HOME/MagicMirror}"
PORT="${PORT:-8090}"
NAME="mm-manager"

fail() { echo "✗ $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js not found"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is needed (found $(node -v))"
command -v pm2 >/dev/null 2>&1 || fail "pm2 not found. Is MagicMirror started with pm2?"
command -v git >/dev/null 2>&1 || fail "git not found"
[ -f "$MM_DIR/package.json" ] && [ -d "$MM_DIR/js" ] || fail "No MagicMirror installation in $MM_DIR (set MM_DIR)"

echo "✓ Node.js $(node -v), pm2, MagicMirror in $MM_DIR"

pm2 delete "$NAME" >/dev/null 2>&1 || true
cd "$DIR"
MM_DIR="$MM_DIR" PORT="$PORT" pm2 start server.js --name "$NAME" --update-env >/dev/null
pm2 save >/dev/null
echo "✓ Started as pm2 process \"$NAME\" (pm2 save done, it comes back after a reboot)"

sleep 2
if ! curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
	echo "! The manager does not answer yet. Check: pm2 logs $NAME"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Open http://${IP:-<your-pi>}:$PORT"
