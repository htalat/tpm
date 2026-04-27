#!/usr/bin/env bash
# Cut a tpm release. Bumps package.json version, commits, tags, pushes,
# creates the GitHub release. Aborts loudly on any precondition failure.
#
# Usage: scripts/release.sh <patch|minor|major> [--notes <file>]
#
#   --notes <file>   Use this markdown file for the tag annotation and the
#                    GitHub release body. If omitted, the script uses
#                    `gh release create --generate-notes`.

set -euo pipefail

die() { printf 'release: %s\n' "$*" >&2; exit 1; }

# ---- args -----------------------------------------------------------------
BUMP="${1:-}"
NOTES_FILE=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES_FILE="${2:-}"; [ -n "$NOTES_FILE" ] || die "--notes needs a file"; shift 2;;
    *) die "unknown arg: $1";;
  esac
done

case "$BUMP" in
  patch|minor|major) ;;
  *) die "usage: scripts/release.sh <patch|minor|major> [--notes <file>]";;
esac

if [ -n "$NOTES_FILE" ] && [ ! -f "$NOTES_FILE" ]; then
  die "notes file not found: $NOTES_FILE"
fi

# ---- preconditions --------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="$(git symbolic-ref --short HEAD)"
[ "$BRANCH" = "main" ] || die "must be on main, currently on: $BRANCH"

[ -z "$(git status --porcelain)" ] || die "working tree dirty; commit or stash first"

git fetch --quiet origin main
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse '@{u}')"
BASE="$(git merge-base @ '@{u}')"
[ "$LOCAL" = "$REMOTE" ] || {
  if   [ "$LOCAL" = "$BASE" ];  then die "behind origin/main; pull first"
  elif [ "$REMOTE" = "$BASE" ]; then die "ahead of origin/main; push first"
  else                               die "diverged from origin/main"
  fi
}

# package.json version must match the latest tag (if any), otherwise the
# tree drifted out from under a previous release.
CURRENT_VERSION="$(node -p "require('./package.json').version")"
LATEST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "v$CURRENT_VERSION" ]; then
  die "package.json version v$CURRENT_VERSION doesn't match latest tag $LATEST_TAG; reconcile first"
fi

# ---- gates ----------------------------------------------------------------
printf 'release: running tests...\n'
npm test --silent

# ---- bump -----------------------------------------------------------------
# `npm version --no-git-tag-version` updates package.json without git side effects.
NEW_TAG="$(npm version "$BUMP" --no-git-tag-version)"   # prints e.g. "v0.2.0"
NEW_VERSION="${NEW_TAG#v}"

if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
  # Restore package.json before bailing so the tree stays clean.
  git checkout -- package.json
  die "tag $NEW_TAG already exists locally"
fi
if git ls-remote --tags origin "$NEW_TAG" | grep -q "$NEW_TAG"; then
  git checkout -- package.json
  die "tag $NEW_TAG already exists on origin"
fi

# ---- commit + tag + push --------------------------------------------------
git add package.json
git commit --quiet -m "Release $NEW_TAG"

if [ -n "$NOTES_FILE" ]; then
  git tag -a "$NEW_TAG" -F "$NOTES_FILE"
else
  git tag -a "$NEW_TAG" -m "Release $NEW_TAG"
fi

git push --quiet origin main
git push --quiet origin "$NEW_TAG"

# ---- gh release -----------------------------------------------------------
if [ -n "$NOTES_FILE" ]; then
  URL="$(gh release create "$NEW_TAG" --title "$NEW_TAG" --notes-file "$NOTES_FILE")"
else
  URL="$(gh release create "$NEW_TAG" --title "$NEW_TAG" --generate-notes)"
fi

printf 'release: shipped %s -> %s\n' "$NEW_TAG" "$URL"
