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

# Stage only release-managed files; never commit unrelated local changes.
git add -A -- fastcdn.js README.md release.sh .github/workflows/check.yml tests/regression.cjs
if git diff --cached --quiet; then
    echo "nothing to release; commit changes and bump VERSION first" >&2
    exit 1
fi

git commit -m "$msg"
git push origin HEAD

git tag -a "$tag" -m "$tag"
git push origin "$tag"

# Report cache invalidation failures instead of silently marking them successful.
if ! curl -fsS --retry 3 --max-time 20 "https://purge.jsdelivr.net/gh/tolipoff-git/lampa-fastcdn@latest/fastcdn.js" >/dev/null; then
    echo "released $tag, but jsDelivr cache purge failed; retry purge manually" >&2
    exit 1
fi
echo "released $tag; jsDelivr @latest cache purged"
