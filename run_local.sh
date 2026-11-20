#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting local OpenFOAM CFD backend on http://127.0.0.1:8787 ..."
python3 "$ROOT_DIR/compute/local_dev_server.py" --host 127.0.0.1 --port 8787 &
BACKEND_PID=$!

cleanup() {
  echo ""
  echo "Stopping local OpenFOAM backend (PID $BACKEND_PID)..."
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting Vite + VTK.js frontend on http://localhost:5173 ..."
cd "$ROOT_DIR/frontend"
npm run dev
