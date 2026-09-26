#!/usr/bin/env bash
# Publish a FastCDN release: commit, push, tag (from fastcdn.js VERSION) and purge
# the jsDelivr @latest cache so the stable install URL serves the new file at once.
# @latest resolves to the newest tag, so VERSION must be bumped for every release.
# Usage: ./release.sh "conventional commit message"
set -euo pipefail

msg="${1:?usage: ./release.sh \"commit message\"}"

cd "$(dirname "$0")"

version="$(sed -n "s/.*var VERSION = '\([0-9][0-9.]*\)'.*/\1/p" fastcdn.js | head -1)"
[ -n "$version" ] || { echo "cannot read VERSION from fastcdn.js" >&2; exit 1; }

tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "tag $tag already exists — bump VERSION in fastcdn.js before releasing" >&2
    exit 1
fi

node --check fastcdn.js || { echo "fastcdn.js: syntax error" >&2; exit 1; }

git add -A
git commit -m "$msg"
git push origin HEAD

git tag -a "$tag" -m "$tag"
git push origin "$tag"

# jsDelivr @latest follows the newest tag; purge to force resolution now.
curl -s "https://purge.jsdelivr.net/gh/tolipoff-git/lampa-fastcdn@latest/fastcdn.js" >/dev/null
echo "released $tag; jsDelivr @latest cache purged"
