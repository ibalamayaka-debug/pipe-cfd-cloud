"""
Modal Serverless OpenFOAM Compute Backend ($0/mo within $30/mo permanent free credit).

Supports BOTH modes automatically:
  - R2 Mode (when R2_BUCKET_NAME is set in secret): uploads .vtp directly to Cloudflare R2
  - Zero-Card KV Mode (no R2 needed!): returns .vtp inline to Cloudflare Worker to save in KV

Deploy with:
    pip install modal
    modal setup
    modal secret create pipe-cfd-secrets COMPUTE_AUTH_TOKEN=<random-long-secret>
    modal deploy compute/modal_app.py
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import modal

app = modal.App("pipe-cfd-openfoam")

openfoam_image = (
    modal.Image.from_registry("opencfd/openfoam-run:2412", add_python="3.11")
    .apt_install("python3-vtk9", "libgl1", "libxrender1")
    .pip_install("fastapi[standard]", "boto3", "numpy", "vtk")
    .add_local_file("compute/pipe_solver.py", "/root/pipe_solver.py")
    .add_local_file("compute/r2_client.py", "/root/r2_client.py")
)


@app.function(
    image=openfoam_image,
    cpu=2.0,
    memory=2048,
    timeout=180,
    scaledown_window=30,
    secrets=[modal.Secret.from_name("pipe-cfd-secrets")],
)
@modal.fastapi_endpoint(method="POST")
def simulate(payload: dict, authorization: str | None = None):
    import sys

    sys.path.insert(0, "/root")
    from fastapi import HTTPException
    from pipe_solver import PipeParams, run_pipe_simulation
    from r2_client import read_cached_metrics_from_r2, upload_case_to_r2

    expected_token = os.environ.get("COMPUTE_AUTH_TOKEN", "")
    if expected_token:
        provided = (authorization or "").replace("Bearer ", "").strip()
        if provided != expected_token:
            raise HTTPException(status_code=401, detail="Unauthorized compute request")

    params = PipeParams(
        diameter_mm=float(payload.get("diameter_mm", 50.0)),
        velocity_ms=float(payload.get("velocity_ms", 1.2)),
        bend_angle_deg=float(payload.get("bend_angle_deg", 90.0)),
        viscosity_m2s=float(payload.get("viscosity_m2s", 1.0e-6)),
        density_kgm3=float(payload.get("density_kgm3", 998.2)),
    ).normalized()

    case_key = params.case_key()
    force = bool(payload.get("force", False))
    use_r2 = bool(os.environ.get("R2_BUCKET_NAME"))

    if use_r2 and not force:
        cached = read_cached_metrics_from_r2(case_key)
        if cached is not None:
            return {"status": "ok", "cached": True, "metrics": cached}

    with tempfile.TemporaryDirectory(prefix=f"modal_cfd_{case_key}_") as out_str:
        out_dir = Path(out_str)
        metrics = run_pipe_simulation(params, out_dir)
        if use_r2:
            upload_case_to_r2(case_key, out_dir)
            return {"status": "ok", "cached": False, "metrics": metrics}

        files_content = {}
        for fname in ("wall.vtp", "slice.vtp", "vectors.vtp", "metrics.json"):
            fpath = out_dir / fname
            if fpath.is_file():
                files_content[fname] = fpath.read_text(encoding="utf-8")
        return {
            "status": "ok",
            "cached": False,
            "metrics": metrics,
            "files_content": files_content,
        }
