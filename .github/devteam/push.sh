#!/usr/bin/env bash
# Commit everything in the current repo and push it to $BRANCH.
# The agent never ran in this .git (it worked in a sandbox copy), and hooks are off.
# Usage: push.sh "<commit message>" [--force]
set -euo pipefail
git add -A
git -c core.hooksPath=/dev/null commit -q -m "$1" || echo "nothing to commit"
git -c core.hooksPath=/dev/null push ${2:-} -q \
  "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/${BRANCH}"
