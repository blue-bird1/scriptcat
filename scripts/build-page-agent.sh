#!/usr/bin/env bash
# Build page-agent from source with userscript entry (no auto-init).
# Requires: Node 20+, npm, git. See CONTRIBUTING in page-agent repo.
#
# EMFILE (too many open files): run `ulimit -n 65535` before this script
# if extension's wxt prepare fails during npm install.

set -e

VERSION=1.5.6
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$REPO_ROOT/.build/page-agent"

echo "Building page-agent v$VERSION from source..."

# Raise fd limit to avoid EMFILE during extension's wxt prepare (large monorepo)
ulimit -n 65535 2>/dev/null || true

rm -rf "$REPO_DIR"
git clone --depth 1 --branch "v$VERSION" https://github.com/alibaba/page-agent.git "$REPO_DIR"
cp "$SCRIPT_DIR/page-agent-userscript-entry.ts" "$REPO_DIR/packages/page-agent/src/demo.ts"

# Match CI/release: npm install, then build:libs (builds all packages including page-agent IIFE)
(cd "$REPO_DIR" && npm install && npm run build:libs)

mkdir -p "$REPO_ROOT/vendor"
cp "$REPO_DIR/packages/page-agent/dist/iife/page-agent.demo.js" "$REPO_ROOT/vendor/page-agent.js"
rm -rf "$REPO_DIR"

echo "Done. Output: $REPO_ROOT/vendor/page-agent.js"
