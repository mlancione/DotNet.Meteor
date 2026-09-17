#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_VERSION:?}"
: "${GITHUB_SHA:?}"
[[ "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1
TAG="local-v$RELEASE_VERSION"
# Never overwrite a version belonging to a different source commit.
if git show-ref --verify --quiet "refs/tags/$TAG"; then
  [[ "$(git rev-list -n 1 "$TAG")" == "$GITHUB_SHA" ]] || {
    echo "Release $TAG already belongs to another commit. Choose a new version." >&2
    exit 1
  }
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" artifacts/*.vsix --clobber
else
  gh release create "$TAG" artifacts/*.vsix \
    --target "$GITHUB_SHA" \
    --title ".NET Meteor (Local) $RELEASE_VERSION" \
    --notes-file .github/release-notes.md \
    --latest
fi
