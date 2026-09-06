#!/usr/bin/env bash
#
# Build and publish the SPA to its nginx document root.
#
# The important part is what this does NOT do: `rsync --delete`.
#
# The admin router lazy-loads ~116 route chunks, each under a content hash. A
# --delete sync removes the previous build's chunks the instant the new one
# lands, so every browser tab that was already open is left holding an
# index.html that references files the server no longer has. The next sidebar
# click 404s on its chunk, Vite fires vite:preloadError, and the handler in
# src/index.jsx hard-reloads the page -- which is exactly the "clicking a
# sidebar option refreshes the whole page" report, and it happens after every
# single deploy for anyone who had the panel open.
#
# Keeping the old hashed assets costs a few MB and makes a deploy invisible to
# open sessions: their chunks still resolve, and they pick up the new build on
# their next natural reload. Stale assets are pruned on a later deploy, once no
# realistic session could still be holding them.
#
# Usage:  deploy-frontend.sh [document-root]      (default /srv/minto/admin)
set -euo pipefail

ROOT="${1:-/srv/minto/admin}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../Frontend" && pwd)"

# How long an old chunk stays reachable. Comfortably longer than a working day,
# so a tab left open over lunch still works, and short enough that assets/ does
# not grow without bound.
RETAIN_DAYS="${RETAIN_DAYS:-7}"

echo "==> Building $SRC"
cd "$SRC"

# The 2 GB box OOMs on the default heap: the build peaks around 1 GB and V8
# gives up before it finishes. Overridable for larger machines.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1600}"

npm run build
# Guard against a failed build being published. Piping the build into anything
# (tail, grep) puts the pipeline's exit status in the way and set -e never
# fires -- which is how a broken bundle got deployed once already.
if [ ! -f dist/index.html ]; then
    echo "!! Build produced no dist/index.html; refusing to deploy" >&2
    exit 1
fi

echo "==> Publishing to $ROOT (keeping previous chunks)"
sudo mkdir -p "$ROOT"
# No --delete. New files land, index.html is replaced, old chunks stay put.
sudo rsync -a "$SRC/dist/" "$ROOT/"

echo "==> Pruning assets older than ${RETAIN_DAYS}d"
# Only ever touches hashed build output. index.html and anything outside
# assets/ is left alone, and -newer against index.html keeps everything the
# current build just wrote regardless of its mtime.
if [ -d "$ROOT/assets" ]; then
    before=$(find "$ROOT/assets" -type f | wc -l)
    sudo find "$ROOT/assets" -type f \
        -mtime "+${RETAIN_DAYS}" \
        ! -newer "$ROOT/index.html" \
        -delete
    after=$(find "$ROOT/assets" -type f | wc -l)
    echo "    assets: $before -> $after"
fi

echo "==> Serving $(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$ROOT/index.html" | head -1)"
echo "==> Done"
