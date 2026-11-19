#!/usr/bin/env bash
# Clone the public fixture repos and pin each to a fixed sha (detached HEAD) so every
# run of the sweep sees the same history. Idempotent: existing clones are reused and only
# fetched if the pinned sha is missing. Full clones (the extractor needs blob sizes).
#
#   scripts/fixtures.sh            # -> ../fixtures (relative to the repo root)
#   scripts/fixtures.sh /some/dir  # -> /some/dir
#
# Keep in sync with fixtures.json (name, ref).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/../fixtures}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

# name  url  pinned-sha
FIXTURES=(
  "chalk    https://github.com/chalk/chalk.git         72110019e147683f60e13fa0ff5c14a0c27cd9fe"
  "express  https://github.com/expressjs/express.git   43fca52d28a422c8be48fd489cbd4f2d6152bab6"
  "vue-core https://github.com/vuejs/core.git          096dc120aeccc4fed4056b32413c1868c7f70857"
  "ripgrep  https://github.com/BurntSushi/ripgrep.git  fdf7d95485ec69c599418b7e7154baa4518fed2c"
)

has_commit() { git -C "$1" cat-file -e "$2^{commit}" 2>/dev/null; }

# One at a time on purpose: small machine, shared network.
for line in "${FIXTURES[@]}"; do
  read -r name url sha <<<"$line"
  dir="$DEST/$name"
  if [ ! -d "$dir/.git" ]; then
    echo "== $name: cloning $url"
    git clone --no-checkout --quiet "$url" "$dir"
  fi
  if ! has_commit "$dir" "$sha"; then
    echo "== $name: fetching (pinned sha not present)"
    git -C "$dir" fetch --quiet origin
    has_commit "$dir" "$sha" || { echo "!! $name: $sha not found on $url" >&2; exit 1; }
  fi
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" != "$sha" ] || \
     [ "$(git -C "$dir" symbolic-ref -q HEAD || true)" != "" ]; then
    git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach "$sha"
  fi
  n=$(git -C "$dir" rev-list --first-parent --count HEAD)
  f=$(git -C "$dir" ls-tree -r HEAD | grep -vc '^160000' || true)
  s=$(du -sh "$dir/.git" | cut -f1)
  echo "   $name @ ${sha:0:12}: $n first-parent commits, $f files, .git $s"
done
