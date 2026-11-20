"""
FastAPI Compute Server (Alternative backend for Google Cloud Run / Docker).
Uses the exact same OpenFOAM solver and R2 uploader as Modal.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from pipe_solver import PipeParams, run_pipe_simulation
from r2_client import read_cached_metrics_from_r2, upload_case_to_r2

app = FastAPI(title="Pipe CFD OpenFOAM Compute")


class SimulationRequest(BaseModel):
    diameter_mm: float = Field(50.0, ge=20.0, le=200.0)
    velocity_ms: float = Field(1.2, ge=0.1, le=10.0)
    bend_angle_deg: float = Field(90.0, ge=15.0, le=180.0)
    viscosity_m2s: float = Field(1.0e-6, ge=1.0e-6, le=5.0e-4)
    density_kgm3: float = Field(998.2, ge=0.5, le=2000.0)
    force: bool = False


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/simulate")
def simulate(req: SimulationRequest, authorization: str | None = Header(default=None)):
    expected = os.environ.get("COMPUTE_AUTH_TOKEN", "")
    if expected:
        provided = (authorization or "").replace("Bearer ", "").strip()
        if provided != expected:
            raise HTTPException(status_code=401, detail="Unauthorized")

    params = PipeParams(
        diameter_mm=req.diameter_mm,
        velocity_ms=req.velocity_ms,
        bend_angle_deg=req.bend_angle_deg,
        viscosity_m2s=req.viscosity_m2s,
        density_kgm3=req.density_kgm3,
    ).normalized()
    case_key = params.case_key()

    if not req.force:
        cached = read_cached_metrics_from_r2(case_key)
        if cached is not None:
            return {"status": "ok", "cached": True, "metrics": cached}

    with tempfile.TemporaryDirectory(prefix=f"cloudrun_cfd_{case_key}_") as out_str:
        out_dir = Path(out_str)
        metrics = run_pipe_simulation(params, out_dir)
        upload_case_to_r2(case_key, out_dir)

    return {"status": "ok", "cached": False, "metrics": metrics}
