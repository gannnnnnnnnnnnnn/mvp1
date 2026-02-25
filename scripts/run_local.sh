#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d "node_modules" ]; then
  echo "[run_local] node_modules missing, running npm ci..."
  npm ci
fi

echo "[run_local] Starting local dev server..."
echo "[run_local] URLs:"
echo "  http://localhost:3000/onboarding"
echo "  http://localhost:3000/phase3"
echo "  http://localhost:3000/inbox"
echo "[run_local] Local data lives under uploads/* (git-ignored)."

npm run dev

