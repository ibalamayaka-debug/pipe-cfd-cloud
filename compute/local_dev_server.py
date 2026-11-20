"""
Zero-dependency Local Dev Server for Pipe CFD Cloud.

Emulates the Cloudflare Workers + R2 + Modal OpenFOAM pipeline locally on your
machine using your installed OpenFOAM (e.g. /usr/lib/openfoam/openfoam2512),
Python stdlib http.server, and a local cache folder (`.local_r2_cache/`).

Run:
    python3 compute/local_dev_server.py --port 8787
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from pipe_solver import PipeParams, run_pipe_simulation

CACHE_ROOT = Path(__file__).resolve().parent.parent / ".local_r2_cache"
SOLVER_LOCK = threading.Lock()


def list_cached_cases() -> list[dict]:
    cases_dir = CACHE_ROOT / "cases"
    if not cases_dir.exists():
        return []
    items = []
    for mfile in sorted(cases_dir.glob("*/metrics.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            items.append(json.loads(mfile.read_text()))
        except Exception:
            pass
    return items[:20]


class LocalCFDHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json({"status": "ok", "mode": "local-openfoam"})
            return

        if path == "/api/cases":
            self._send_json({"cases": list_cached_cases()})
            return

        if path.startswith("/api/results/"):
            parts = path.removeprefix("/api/results/").split("/")
            if len(parts) == 2:
                case_key, filename = parts
                if filename not in ("wall.vtp", "slice.vtp", "vectors.vtp", "metrics.json"):
                    self._send_json({"error": "Invalid file"}, 400)
                    return
                fpath = CACHE_ROOT / "cases" / case_key / filename
                if not fpath.is_file():
                    self._send_json({"error": "Not found"}, 404)
                    return
                raw = fpath.read_bytes()
                ctype = mimetypes.guess_type(filename)[0] or "application/xml"
                if filename.endswith(".vtp"):
                    ctype = "application/xml; charset=utf-8"
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return

        self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/simulate":
            self._send_json({"error": "Not found"}, 404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            self._send_json({"error": "Invalid JSON body"}, 400)
            return

        params = PipeParams(
            diameter_mm=float(payload.get("diameter_mm", 50.0)),
            velocity_ms=float(payload.get("velocity_ms", 1.2)),
            bend_angle_deg=float(payload.get("bend_angle_deg", 90.0)),
            viscosity_m2s=float(payload.get("viscosity_m2s", 1.0e-6)),
            density_kgm3=float(payload.get("density_kgm3", 998.2)),
        ).normalized()
        case_key = params.case_key()
        case_dir = CACHE_ROOT / "cases" / case_key
        metrics_file = case_dir / "metrics.json"
        force = bool(payload.get("force", False))

        if not force and metrics_file.is_file():
            metrics = json.loads(metrics_file.read_text())
            self._send_json(
                {
                    "status": "ok",
                    "cached": True,
                    "backend": "local-r2-cache",
                    "case_key": case_key,
                    "metrics": metrics,
                    "urls": {
                        "wall": f"/api/results/{case_key}/wall.vtp",
                        "slice": f"/api/results/{case_key}/slice.vtp",
                        "vectors": f"/api/results/{case_key}/vectors.vtp",
                        "metrics": f"/api/results/{case_key}/metrics.json",
                    },
                }
            )
            return

        try:
            with SOLVER_LOCK:
                # Re-check cache after acquiring lock
                if not force and metrics_file.is_file():
                    metrics = json.loads(metrics_file.read_text())
                    cached = True
                else:
                    metrics = run_pipe_simulation(params, case_dir)
                    cached = False
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)
            return

        self._send_json(
            {
                "status": "ok",
                "cached": cached,
                "backend": "local-openfoam",
                "case_key": case_key,
                "metrics": metrics,
                "urls": {
                    "wall": f"/api/results/{case_key}/wall.vtp",
                    "slice": f"/api/results/{case_key}/slice.vtp",
                    "vectors": f"/api/results/{case_key}/vectors.vtp",
                    "metrics": f"/api/results/{case_key}/metrics.json",
                },
            }
        )


def main():
    parser = argparse.ArgumentParser(description="Local Pipe CFD OpenFOAM Dev Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), LocalCFDHandler)
    print(f"[Pipe CFD Local Server] Listening on http://{args.host}:{args.port}")
    print(f"[Pipe CFD Local Server] Cache directory: {CACHE_ROOT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")


if __name__ == "__main__":
    main()
