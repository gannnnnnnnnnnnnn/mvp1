#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/reset_local_state.sh analysis
  ./scripts/reset_local_state.sh uploads --yes

Modes:
  analysis   Reset local analysis state only:
             - uploads/review_state.json
             - uploads/overrides.json
             - uploads/analysis-cache
             - uploads/transfer-cache
             - uploads/dev-runs

  uploads    Delete all uploaded PDFs and runtime caches.
             Requires --yes because this is destructive.
EOF
}

remove_path() {
  local target="$1"
  if [ -e "$target" ]; then
    rm -rf "$target"
    echo "[reset_local_state] removed $target"
  fi
}

reset_analysis() {
  echo "[reset_local_state] Resetting analysis state only..."
  remove_path "uploads/review_state.json"
  remove_path "uploads/overrides.json"
  remove_path "uploads/analysis-cache"
  remove_path "uploads/transfer-cache"
  remove_path "uploads/dev-runs"
  echo "[reset_local_state] Analysis state reset complete. PDFs were not deleted."
}

reset_uploads() {
  if [ "${2:-}" != "--yes" ]; then
    echo "[reset_local_state] Refusing to delete uploads without --yes."
    usage
    exit 1
  fi

  echo "[reset_local_state] WARNING: deleting all uploaded PDFs and runtime state..."
  remove_path "uploads"
  mkdir -p "uploads"
  echo "[reset_local_state] Uploads directory recreated empty."
}

case "${1:-}" in
  analysis)
    reset_analysis
    ;;
  uploads)
    reset_uploads "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac
