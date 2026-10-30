#!/usr/bin/env bash
# Install with: ln -sf ../../pre-commit-hook.sh .git/hooks/pre-commit
set -euo pipefail
cd "$(dirname "$0")/.."
npm run check
