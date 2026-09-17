#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_VERSION:?}"
: "${GITHUB_SHA:?}"
: "${GH_REPO:?}"
[[ "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1
TAG="local-v$RELEASE_VERSION"
TAG_EXISTS=false
# Never overwrite a version belonging to a different source commit.
if git show-ref --verify --quiet "refs/tags/$TAG"; then
  TAG_EXISTS=true
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
elif [[ "$TAG_EXISTS" == false ]]; then
  RELEASE_TARGET=$(gh release view "$TAG" --json targetCommitish --jq .targetCommitish)
  [[ "$RELEASE_TARGET" == "$GITHUB_SHA" ]] || {
    echo "Draft $TAG belongs to another commit. Choose a new version." >&2
    exit 1
  }
fi
RELEASE_ID=$(gh release view "$TAG" --json databaseId --jq .databaseId)
# The direct API avoids hangs seen in `gh release upload`. Resume completed assets
# and keep the release draft until every upload has succeeded.
for asset in artifacts/*.vsix; do
  name="${asset##*/}"
  size=$(wc -c < "$asset" | tr -d ' ')
  uploaded=false
  for attempt in 1 2; do
    complete=$(gh api "repos/$GH_REPO/releases/$RELEASE_ID/assets" --jq ".[] | select(.name == \"$name\" and .state == \"uploaded\" and .size == $size) | .id")
    if [[ -n "$complete" ]]; then
      uploaded=true
      break
    fi
    incomplete=$(gh api "repos/$GH_REPO/releases/$RELEASE_ID/assets" --jq ".[] | select(.name == \"$name\") | .id")
    if [[ -n "$incomplete" ]]; then
      gh api --method DELETE "repos/$GH_REPO/releases/assets/$incomplete"
    fi
    if GODEBUG=http2client=0 timeout 120s gh api --method POST \
      "https://uploads.github.com/repos/$GH_REPO/releases/$RELEASE_ID/assets?name=$name" \
      -H 'Content-Type: application/octet-stream' --input "$asset" --jq '{name,size,state}'; then
      uploaded=true
      break
    fi
  done
  [[ "$uploaded" == true ]] || { echo "Upload failed: $name" >&2; exit 1; }
done
gh release edit "$TAG" --draft=false --latest
