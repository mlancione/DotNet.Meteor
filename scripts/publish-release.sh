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
if ! gh release view "$TAG" >/dev/null 2>&1; then
  gh release create "$TAG" \
    --target "$GITHUB_SHA" \
    --title ".NET Meteor (Local) $RELEASE_VERSION" \
    --notes-file .github/release-notes.md \
    --draft
fi
# Use HTTP/1.1 to avoid stalled HTTP/2 uploads; bound and retry each file.
# Keep the release draft until every asset has been uploaded successfully.
for asset in artifacts/*.vsix; do
  if ! GODEBUG=http2client=0 timeout 120s gh release upload "$TAG" "$asset" --clobber; then
    GODEBUG=http2client=0 timeout 120s gh release upload "$TAG" "$asset" --clobber
  fi
done
gh release edit "$TAG" --draft=false --latest
