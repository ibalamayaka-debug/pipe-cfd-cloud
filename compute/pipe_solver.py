"""
Parametric 3D Bent Pipe OpenFOAM Solver + Compact VTK (.vtp) Exporter.

Generates a true circular cross-section 5-block O-grid (butterfly) hexahedral
mesh for an arbitrary pipe diameter, bend angle, inlet velocity, and kinematic
viscosity; runs OpenFOAM (blockMesh + simpleFoam + foamToVTK); computes
engineering KPIs (pressure drop, Reynolds number, Dean number, loss coeff K);
and extracts 3 compact VTK.js-compatible .vtp files:
  - wall.vtp    : 3D pipe wall surface with pressure (p) & velocity magnitude
  - slice.vtp   : z=0 center symmetry plane with p, U (3D vector), U_mag
  - vectors.vtp : Downsampled 3D interior velocity points for arrow glyphs
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# Default OpenFOAM bashrc search paths (works both locally on v2512 and in Docker/Modal)
OPENFOAM_BASHRC_CANDIDATES = [
    os.environ.get("OPENFOAM_BASHRC", ""),
    "/usr/lib/openfoam/openfoam2512/etc/bashrc",
    "/usr/lib/openfoam/openfoam2412/etc/bashrc",
    "/usr/lib/openfoam/openfoam2406/etc/bashrc",
    "/usr/lib/openfoam/openfoam2312/etc/bashrc",
    "/opt/openfoam2512/etc/bashrc",
    "/opt/openfoam2412/etc/bashrc",
    "/opt/openfoam2406/etc/bashrc",
    "/opt/openfoam11/etc/bashrc",
]


@dataclass(frozen=True)
class PipeParams:
    diameter_mm: float = 50.0       # Pipe inner diameter D [mm], range 20..200
    velocity_ms: float = 1.0        # Mean inlet velocity U [m/s], range 0.1..10.0
    bend_angle_deg: float = 90.0    # Bend angle theta [deg], range 15..180
    viscosity_m2s: float = 1.0e-6   # Kinematic viscosity nu [m^2/s], range 1e-6..5e-4
    density_kgm3: float = 998.2     # Fluid density rho [kg/m^3] for Pa conversion

    def normalized(self) -> "PipeParams":
        """Clamp and round parameters for deterministic cache keys & safe solver bounds."""
        d = round(min(max(float(self.diameter_mm), 20.0), 200.0), 1)
        u = round(min(max(float(self.velocity_ms), 0.1), 10.0), 2)
        theta = round(min(max(float(self.bend_angle_deg), 15.0), 180.0), 0)
        nu = float(f"{min(max(float(self.viscosity_m2s), 1.0e-6), 5.0e-4):.2e}")
        rho = round(min(max(float(self.density_kgm3), 0.5), 2000.0), 1)
        return PipeParams(
            diameter_mm=d,
            velocity_ms=u,
            bend_angle_deg=theta,
            viscosity_m2s=nu,
            density_kgm3=rho,
        )

    def case_key(self) -> str:
        p = self.normalized()
        canonical = (
            f"d={p.diameter_mm:.1f}|u={p.velocity_ms:.2f}|"
            f"a={p.bend_angle_deg:.0f}|nu={p.viscosity_m2s:.2e}|rho={p.density_kgm3:.1f}"
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def find_openfoam_bashrc() -> Optional[str]:
    for path in OPENFOAM_BASHRC_CANDIDATES:
        if path and os.path.isfile(path):
            return path
    return None


def _run_foam_cmd(case_dir: Path, cmd: str, timeout: int = 120) -> str:
    bashrc = find_openfoam_bashrc()
    if bashrc:
        full_cmd = f"source '{bashrc}' >/dev/null 2>&1 || true; {cmd}"
    else:
        full_cmd = cmd
    proc = subprocess.run(
        ["bash", "-lc", full_cmd],
        cwd=str(case_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = "\n".join(proc.stdout.splitlines()[-40:])
        raise RuntimeError(f"OpenFOAM command failed ({cmd}):\n{tail}")
    return proc.stdout


def generate_block_mesh_dict(params: PipeParams) -> str:
    """
    Build a smooth 3D 5-block O-grid (butterfly) circular pipe with:
      - Straight inlet section: L_in = 2.5 * D
      - Circular-arc bend of angle theta (deg) and centerline radius R_b = 2.0 * D
      - Straight outlet section: L_out = 3.5 * D
    The bend lies in the z=0 plane so z=0 is the exact center symmetry plane.
    """
    D = params.diameter_mm * 1e-3
    r = 0.5 * D
    R_b = 2.0 * D
    L_in = 2.5 * D
    L_out = 3.5 * D
    theta = math.radians(params.bend_angle_deg)

    # Number of bend arc segments (keep every arc <= 60 deg for high accuracy)
    n_bend_segs = max(2, math.ceil(params.bend_angle_deg / 60.0))

    # O-grid cross-section local coordinates (u along n, v along b=z)
    a = 0.36 * r
    c = r / math.sqrt(2.0)
    local_pts: List[Tuple[float, float]] = [
        (-a, -a),  # 0 inner SW
        (+a, -a),  # 1 inner SE
        (+a, +a),  # 2 inner NE
        (-a, +a),  # 3 inner NW
        (-c, -c),  # 4 outer SW (-135 deg)
        (+c, -c),  # 5 outer SE (-45 deg)
        (+c, +c),  # 6 outer NE (+45 deg)
        (-c, +c),  # 7 outer NW (+135 deg)
    ]

    # Build stations: list of (center_xyz, n_xyz, b_xyz)
    stations: List[Tuple[Tuple[float, float, float], Tuple[float, float, float], Tuple[float, float, float]]] = []

    # Station 0: Inlet entrance
    stations.append(((-L_in, R_b, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))

    # Bend stations: alpha = 0 .. theta
    bend_alphas = [theta * i / n_bend_segs for i in range(n_bend_segs + 1)]
    for alpha in bend_alphas:
        center = (R_b * math.sin(alpha), R_b * math.cos(alpha), 0.0)
        n_vec = (math.sin(alpha), math.cos(alpha), 0.0)
        b_vec = (0.0, 0.0, 1.0)
        stations.append((center, n_vec, b_vec))

    # Last station: Outlet exit
    end_center = (R_b * math.sin(theta), R_b * math.cos(theta), 0.0)
    t_end = (math.cos(theta), -math.sin(theta), 0.0)
    n_end = (math.sin(theta), math.cos(theta), 0.0)
    out_center = (
        end_center[0] + L_out * t_end[0],
        end_center[1] + L_out * t_end[1],
        0.0,
    )
    stations.append((out_center, n_end, (0.0, 0.0, 1.0)))

    def station_point(center, n_vec, b_vec, u: float, v: float) -> Tuple[float, float, float]:
        return (
            center[0] + u * n_vec[0] + v * b_vec[0],
            center[1] + u * n_vec[1] + v * b_vec[1],
            center[2] + u * n_vec[2] + v * b_vec[2],
        )

    # Assemble vertices
    vertex_lines: List[str] = []
    for s_idx, (center, n_vec, b_vec) in enumerate(stations):
        vertex_lines.append(f"    // station {s_idx}")
        for k, (u, v) in enumerate(local_pts):
            x, y, z = station_point(center, n_vec, b_vec, u, v)
            vertex_lines.append(f"    ({x:.8g} {y:.8g} {z:.8g}) // {s_idx * 8 + k}")

    # Mesh resolution (~7,500 hexahedral cells -> solves in ~4-10s on 2 vCPU)
    nc = 6
    nr = 5
    nz_in = 12
    nz_bend_seg = max(8, round((params.bend_angle_deg / 90.0) * 18 / n_bend_segs))
    nz_out = 16

    n_sections = len(stations) - 1
    block_lines: List[str] = []
    for sec in range(n_sections):
        A = sec * 8
        B = (sec + 1) * 8
        if sec == 0:
            nz = nz_in
        elif sec == n_sections - 1:
            nz = nz_out
        else:
            nz = nz_bend_seg

        # 5 right-handed hex blocks per section:
        # Core: (0 1 2 3)
        block_lines.append(
            f"    hex ({A+0} {A+1} {A+2} {A+3}  {B+0} {B+1} {B+2} {B+3}) ({nc} {nc} {nz}) simpleGrading (1 1 1)"
        )
        # Bottom ring: (4 5 1 0), radial 4->0 is wall->core (grade 2.0 => finer near wall)
        block_lines.append(
            f"    hex ({A+4} {A+5} {A+1} {A+0}  {B+4} {B+5} {B+1} {B+0}) ({nc} {nr} {nz}) simpleGrading (1 2.0 1)"
        )
        # Right (outer bend) ring: (1 5 6 2), radial 1->5 is core->wall (grade 0.5 => finer near wall)
        block_lines.append(
            f"    hex ({A+1} {A+5} {A+6} {A+2}  {B+1} {B+5} {B+6} {B+2}) ({nr} {nc} {nz}) simpleGrading (0.5 1 1)"
        )
        # Top ring: (3 2 6 7), radial 3->7 is core->wall (grade 0.5 => finer near wall)
        block_lines.append(
            f"    hex ({A+3} {A+2} {A+6} {A+7}  {B+3} {B+2} {B+6} {B+7}) ({nc} {nr} {nz}) simpleGrading (1 0.5 1)"
        )
        # Left (inner bend) ring: (4 0 3 7), radial 4->0 is wall->core (grade 2.0 => finer near wall)
        block_lines.append(
            f"    hex ({A+4} {A+0} {A+3} {A+7}  {B+4} {B+0} {B+3} {B+7}) ({nr} {nc} {nz}) simpleGrading (2.0 1 1)"
        )

    # Edges:
    # 1) Cross-section circular perimeter arcs at every station
    edge_lines: List[str] = []
    cross_arcs = [
        (4, 5, (0.0, -r)),
        (5, 6, (+r, 0.0)),
        (6, 7, (0.0, +r)),
        (7, 4, (-r, 0.0)),
    ]
    for s_idx, (center, n_vec, b_vec) in enumerate(stations):
        base = s_idx * 8
        for i0, i1, (um, vm) in cross_arcs:
            mx, my, mz = station_point(center, n_vec, b_vec, um, vm)
            edge_lines.append(f"    arc {base+i0} {base+i1} ({mx:.8g} {my:.8g} {mz:.8g})")

    # 2) Longitudinal circular bend arcs for all 8 vertices across bend segments
    for seg in range(n_bend_segs):
        sA = 1 + seg
        sB = 1 + seg + 1
        A = sA * 8
        B = sB * 8
        alpha_m = 0.5 * (bend_alphas[seg] + bend_alphas[seg + 1])
        c_m = (R_b * math.sin(alpha_m), R_b * math.cos(alpha_m), 0.0)
        n_m = (math.sin(alpha_m), math.cos(alpha_m), 0.0)
        b_m = (0.0, 0.0, 1.0)
        for k, (u, v) in enumerate(local_pts):
            mx, my, mz = station_point(c_m, n_m, b_m, u, v)
            edge_lines.append(f"    arc {A+k} {B+k} ({mx:.8g} {my:.8g} {mz:.8g})")

    # Boundary faces
    # Inlet is station 0 (outward normal = -t, so CW in (n,b))
    inlet_faces = [
        "(0 3 2 1)",
        "(4 0 1 5)",
        "(1 2 6 5)",
        "(3 7 6 2)",
        "(4 7 3 0)",
    ]
    # Outlet is last station (outward normal = +t, so CCW in (n,b))
    L = (len(stations) - 1) * 8
    outlet_faces = [
        f"({L+0} {L+1} {L+2} {L+3})",
        f"({L+4} {L+5} {L+1} {L+0})",
        f"({L+1} {L+5} {L+6} {L+2})",
        f"({L+3} {L+2} {L+6} {L+7})",
        f"({L+4} {L+0} {L+3} {L+7})",
    ]
    # Pipe outer wall faces across every section
    wall_faces: List[str] = []
    for sec in range(n_sections):
        A = sec * 8
        B = (sec + 1) * 8
        wall_faces.append(f"        ({A+4} {B+4} {B+5} {A+5})")
        wall_faces.append(f"        ({A+5} {B+5} {B+6} {A+6})")
        wall_faces.append(f"        ({A+6} {B+6} {B+7} {A+7})")
        wall_faces.append(f"        ({A+7} {B+7} {B+4} {A+4})")

    return f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}}

scale 1;

vertices
(
{chr(10).join(vertex_lines)}
);

blocks
(
{chr(10).join(block_lines)}
);

edges
(
{chr(10).join(edge_lines)}
);

boundary
(
    inlet
    {{
        type patch;
        faces
        (
            {chr(10).join("            " + f for f in inlet_faces).strip()}
        );
    }}
    outlet
    {{
        type patch;
        faces
        (
            {chr(10).join("            " + f for f in outlet_faces).strip()}
        );
    }}
    walls
    {{
        type wall;
        faces
        (
{chr(10).join(wall_faces)}
        );
    }}
);

mergePatchPairs
(
);
"""


def _write_case_files(case_dir: Path, params: PipeParams) -> Dict[str, float | str]:
    D = params.diameter_mm * 1e-3
    U = params.velocity_ms
    nu = params.viscosity_m2s
    Re = U * D / nu
    is_turbulent = Re >= 2300.0

    # Estimate turbulent inlet quantities for kOmegaSST
    I_turb = 0.16 * (max(Re, 2300.0) ** (-0.125))
    k_in = max(1.5 * (U * I_turb) ** 2, 1e-6)
    l_turb = 0.07 * D
    omega_in = max(math.sqrt(k_in) / (0.09 ** 0.25 * l_turb), 0.1)

    (case_dir / "0").mkdir(parents=True, exist_ok=True)
    (case_dir / "constant").mkdir(parents=True, exist_ok=True)
    (case_dir / "system").mkdir(parents=True, exist_ok=True)

    # system/blockMeshDict
    (case_dir / "system" / "blockMeshDict").write_text(generate_block_mesh_dict(params))

    # system/controlDict
    (case_dir / "system" / "controlDict").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}

application     simpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         400;
deltaT          1;
writeControl    timeStep;
writeInterval   400;
purgeWrite      1;
writeFormat     ascii;
writePrecision  6;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{
    inletPressure
    {
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    writeTime;
        writeFields     false;
        regionType      patch;
        name            inlet;
        operation       areaAverage;
        fields          (p);
    }
    outletPressure
    {
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    writeTime;
        writeFields     false;
        regionType      patch;
        name            outlet;
        operation       areaAverage;
        fields          (p);
    }
}
""")

    # system/fvSchemes
    (case_dir / "system" / "fvSchemes").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}

ddtSchemes
{
    default         steadyState;
}

gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear limited corrected 0.5;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         limited corrected 0.5;
}

wallDist
{
    method          meshWave;
}
""")

    # system/fvSolution
    (case_dir / "system" / "fvSolution").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}

solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-6;
        relTol          0.05;
    }

    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-6;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;

    residualControl
    {
        p               1e-4;
        U               1e-4;
        "(k|omega)"     1e-4;
    }
}

relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        k               0.7;
        omega           0.7;
    }
}
""")

    # constant/transportProperties
    (case_dir / "constant" / "transportProperties").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}}

transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] {nu:.6e};
""")

    # constant/turbulenceProperties
    if is_turbulent:
        turb_dict = """FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}

simulationType  RAS;

RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     off;
}
"""
    else:
        turb_dict = """FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}

simulationType  laminar;
"""
    (case_dir / "constant" / "turbulenceProperties").write_text(turb_dict)

    # 0/U
    (case_dir / "0" / "U").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}}

dimensions      [0 1 -1 0 0 0 0];

internalField   uniform ({U:.6g} 0 0);

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform ({U:.6g} 0 0);
    }}
    outlet
    {{
        type            zeroGradient;
    }}
    walls
    {{
        type            noSlip;
    }}
}}
""")

    # 0/p (kinematic pressure p/rho)
    (case_dir / "0" / "p").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}

dimensions      [0 2 -2 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    walls
    {
        type            zeroGradient;
    }
}
""")

    if is_turbulent:
        # 0/k
        (case_dir / "0" / "k").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      k;
}}

dimensions      [0 2 -2 0 0 0 0];

internalField   uniform {k_in:.6e};

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {k_in:.6e};
    }}
    outlet
    {{
        type            zeroGradient;
    }}
    walls
    {{
        type            kqRWallFunction;
        value           uniform {k_in:.6e};
    }}
}}
""")
        # 0/omega
        (case_dir / "0" / "omega").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      omega;
}}

dimensions      [0 0 -1 0 0 0 0];

internalField   uniform {omega_in:.6e};

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {omega_in:.6e};
    }}
    outlet
    {{
        type            zeroGradient;
    }}
    walls
    {{
        type            omegaWallFunction;
        value           uniform {omega_in:.6e};
    }}
}}
""")
        # 0/nut
        (case_dir / "0" / "nut").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      nut;
}

dimensions      [0 2 -1 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            calculated;
        value           uniform 0;
    }
    outlet
    {
        type            calculated;
        value           uniform 0;
    }
    walls
    {
        type            nutkWallFunction;
        value           uniform 0;
    }
}
""")

    return {
        "reynolds": Re,
        "regime": "Turbulent (k-omega SST)" if is_turbulent else "Laminar",
        "model": "kOmegaSST" if is_turbulent else "laminar",
    }


def _read_postprocess_pressure(case_dir: Path, func_name: str) -> Optional[float]:
    base = case_dir / "postProcessing" / func_name
    if not base.exists():
        return None
    dat_files = sorted(base.rglob("*.dat"))
    if not dat_files:
        return None
    last_val = None
    for line in dat_files[-1].read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            try:
                last_val = float(parts[-1])
            except ValueError:
                pass
    return last_val


def _write_vtp_ascii(polydata, out_path: Path) -> None:
    import vtk

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(out_path))
    writer.SetInputData(polydata)
    # ASCII mode guarantees 100% compatibility with @kitware/vtk.js vtkXMLPolyDataReader
    # without UInt64/zlib header mismatches and stays ~100-350 KB total.
    writer.SetDataModeToAscii()
    if writer.Write() != 1:
        raise RuntimeError(f"Failed writing VTP file: {out_path}")


def _extract_vtk_outputs(
    case_dir: Path, output_dir: Path, rho: float
) -> Dict[str, object]:
    """
    Convert OpenFOAM foamToVTK outputs into 3 compact VTK.js-ready .vtp files
    and compute field ranges & max velocity.
    """
    import vtk
    from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy
    import numpy as np

    vtk_dir = case_dir / "VTK"
    # Find latest internal mesh .vtk (or .vtu)
    internal_files = sorted(
        [p for p in vtk_dir.glob("*.vtk") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
    )
    if not internal_files:
        # Newer OpenFOAM foamToVTK may output in subdirectories or .vtu
        internal_files = sorted(
            [p for p in vtk_dir.rglob("internal.vtu") if p.is_file()],
            key=lambda p: p.stat().st_mtime,
        )
    if not internal_files:
        raise RuntimeError(f"No internal VTK file found in {vtk_dir}")
    internal_path = internal_files[-1]

    if internal_path.suffix == ".vtu":
        reader = vtk.vtkXMLUnstructuredGridReader()
    else:
        reader = vtk.vtkUnstructuredGridReader()
        reader.ReadAllScalarsOn()
        reader.ReadAllVectorsOn()
    reader.SetFileName(str(internal_path))
    reader.Update()
    ug = reader.GetOutput()

    # Convert cell data -> point data for smooth color interpolation in VTK.js
    c2p = vtk.vtkCellDataToPointData()
    c2p.SetInputData(ug)
    c2p.PassCellDataOff()
    c2p.Update()
    ug_pt = c2p.GetOutput()

    pt_data = ug_pt.GetPointData()
    u_arr = pt_data.GetArray("U")
    p_arr = pt_data.GetArray("p")
    if u_arr is None or p_arr is None:
        raise RuntimeError("Missing U or p arrays in VTK output")

    u_np = vtk_to_numpy(u_arr)
    u_mag = np.linalg.norm(u_np, axis=1).astype(np.float32)
    p_pa = (vtk_to_numpy(p_arr) * rho).astype(np.float32)

    # Keep only clean arrays on point data
    for name in [pt_data.GetArrayName(i) for i in range(pt_data.GetNumberOfArrays())]:
        if name not in ("U",):
            pt_data.RemoveArray(name)

    p_vtk = numpy_to_vtk(p_pa, deep=True)
    p_vtk.SetName("p_Pa")
    pt_data.AddArray(p_vtk)

    umag_vtk = numpy_to_vtk(u_mag, deep=True)
    umag_vtk.SetName("U_mag")
    pt_data.AddArray(umag_vtk)
    pt_data.SetActiveScalars("U_mag")

    # 1) Center symmetry slice (z = 0 plane)
    plane = vtk.vtkPlane()
    plane.SetOrigin(0.0, 0.0, 0.0)
    plane.SetNormal(0.0, 0.0, 1.0)

    cutter = vtk.vtkCutter()
    cutter.SetCutFunction(plane)
    cutter.SetInputData(ug_pt)
    cutter.Update()

    slice_tri = vtk.vtkTriangleFilter()
    slice_tri.SetInputConnection(cutter.GetOutputPort())
    slice_tri.Update()
    slice_poly = slice_tri.GetOutput()
    slice_poly.GetPointData().SetActiveScalars("U_mag")
    _write_vtp_ascii(slice_poly, output_dir / "slice.vtp")

    # 2) Outer 3D pipe wall surface (with smooth normals + pressure in Pa)
    geom = vtk.vtkGeometryFilter()
    geom.SetInputData(ug_pt)
    geom.Update()

    wall_tri = vtk.vtkTriangleFilter()
    wall_tri.SetInputConnection(geom.GetOutputPort())
    wall_tri.Update()

    normals = vtk.vtkPolyDataNormals()
    normals.SetInputConnection(wall_tri.GetOutputPort())
    normals.ComputePointNormalsOn()
    normals.SplittingOff()
    normals.Update()
    wall_poly = normals.GetOutput()
    wall_poly.GetPointData().SetActiveScalars("p_Pa")
    _write_vtp_ascii(wall_poly, output_dir / "wall.vtp")

    # 3) Downsampled velocity vectors on the center slice for crisp 3D arrow glyphs
    n_slice_pts = slice_poly.GetNumberOfPoints()
    target_arrows = 320
    step = max(1, n_slice_pts // target_arrows)

    vec_points = vtk.vtkPoints()
    vec_verts = vtk.vtkCellArray()
    vec_u_list: List[List[float]] = []
    vec_mag_list: List[float] = []

    slice_u = vtk_to_numpy(slice_poly.GetPointData().GetArray("U"))
    slice_umag = vtk_to_numpy(slice_poly.GetPointData().GetArray("U_mag"))

    for idx in range(0, n_slice_pts, step):
        mag = float(slice_umag[idx])
        if mag < 1e-4:
            continue
        pt = slice_poly.GetPoint(idx)
        pid = vec_points.InsertNextPoint(pt)
        vec_verts.InsertNextCell(1)
        vec_verts.InsertCellPoint(pid)
        vec_u_list.append([float(slice_u[idx, 0]), float(slice_u[idx, 1]), float(slice_u[idx, 2])])
        vec_mag_list.append(mag)

    vec_poly = vtk.vtkPolyData()
    vec_poly.SetPoints(vec_points)
    vec_poly.SetVerts(vec_verts)

    if vec_u_list:
        u_vec_vtk = numpy_to_vtk(np.array(vec_u_list, dtype=np.float32), deep=True)
        u_vec_vtk.SetName("U")
        vec_poly.GetPointData().SetVectors(u_vec_vtk)

        mag_vec_vtk = numpy_to_vtk(np.array(vec_mag_list, dtype=np.float32), deep=True)
        mag_vec_vtk.SetName("U_mag")
        vec_poly.GetPointData().SetScalars(mag_vec_vtk)

    _write_vtp_ascii(vec_poly, output_dir / "vectors.vtp")

    bounds = list(wall_poly.GetBounds())
    return {
        "n_cells": int(ug.GetNumberOfCells()),
        "max_velocity_ms": round(float(np.max(u_mag)), 4),
        "p_min_pa": round(float(np.min(p_pa)), 3),
        "p_max_pa": round(float(np.max(p_pa)), 3),
        "u_min_ms": 0.0,
        "u_max_ms": round(float(np.max(u_mag)), 4),
        "bounds": [round(b, 6) for b in bounds],
        "files": {
            "wall": "wall.vtp",
            "slice": "slice.vtp",
            "vectors": "vectors.vtp",
        },
        "file_sizes_kb": {
            "wall": round((output_dir / "wall.vtp").stat().st_size / 1024.0, 1),
            "slice": round((output_dir / "slice.vtp").stat().st_size / 1024.0, 1),
            "vectors": round((output_dir / "vectors.vtp").stat().st_size / 1024.0, 1),
        },
    }


def run_pipe_simulation(
    raw_params: PipeParams,
    output_dir: Path,
    keep_case_dir: bool = False,
) -> Dict[str, object]:
    """
    Execute the complete OpenFOAM pipeline and write:
      - output_dir/wall.vtp
      - output_dir/slice.vtp
      - output_dir/vectors.vtp
      - output_dir/metrics.json
    """
    t0 = time.perf_counter()
    params = raw_params.normalized()
    case_key = params.case_key()
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"of_pipe_{case_key}_"))
    try:
        flow_meta = _write_case_files(tmp_dir, params)

        t_mesh0 = time.perf_counter()
        _run_foam_cmd(tmp_dir, "blockMesh", timeout=60)
        t_mesh = time.perf_counter() - t_mesh0

        t_solve0 = time.perf_counter()
        solve_log = _run_foam_cmd(tmp_dir, "simpleFoam", timeout=180)
        t_solve = time.perf_counter() - t_solve0

        # Extract final iteration count from log
        iterations = 0
        for line in solve_log.splitlines():
            if line.startswith("Time = "):
                try:
                    iterations = int(float(line.split("=", 1)[1].strip()))
                except ValueError:
                    pass

        t_vtk0 = time.perf_counter()
        _run_foam_cmd(tmp_dir, "foamToVTK -latestTime -noFaceZones", timeout=60)
        vtk_meta = _extract_vtk_outputs(tmp_dir, output_dir, params.density_kgm3)
        t_vtk = time.perf_counter() - t_vtk0

        p_in_kin = _read_postprocess_pressure(tmp_dir, "inletPressure")
        p_out_kin = _read_postprocess_pressure(tmp_dir, "outletPressure")
        if p_in_kin is not None and p_out_kin is not None:
            dp_pa = (p_in_kin - p_out_kin) * params.density_kgm3
        else:
            dp_pa = float(vtk_meta["p_max_pa"]) - float(vtk_meta["p_min_pa"])

        dyn_p = 0.5 * params.density_kgm3 * (params.velocity_ms ** 2)
        loss_coeff_k = dp_pa / dyn_p if dyn_p > 1e-12 else 0.0

        # Dean number De = Re * sqrt(D / (2 * R_b)) where R_b = 2 * D => sqrt(1/4) = 0.5
        Re = float(flow_meta["reynolds"])
        dean = Re * math.sqrt(0.25)

        total_sec = time.perf_counter() - t0
        metrics: Dict[str, object] = {
            "case_key": case_key,
            "params": asdict(params),
            "kpis": {
                "pressure_drop_pa": round(dp_pa, 3),
                "reynolds_number": round(Re, 1),
                "dean_number": round(dean, 1),
                "loss_coefficient_k": round(loss_coeff_k, 4),
                "max_velocity_ms": vtk_meta["max_velocity_ms"],
                "flow_regime": flow_meta["regime"],
                "turbulence_model": flow_meta["model"],
                "n_cells": vtk_meta["n_cells"],
                "iterations": iterations,
            },
            "fields": {
                "p_min_pa": vtk_meta["p_min_pa"],
                "p_max_pa": vtk_meta["p_max_pa"],
                "u_min_ms": vtk_meta["u_min_ms"],
                "u_max_ms": vtk_meta["u_max_ms"],
                "bounds": vtk_meta["bounds"],
            },
            "timing_sec": {
                "mesh": round(t_mesh, 2),
                "solve": round(t_solve, 2),
                "postprocess": round(t_vtk, 2),
                "total": round(total_sec, 2),
            },
            "files": vtk_meta["files"],
            "file_sizes_kb": vtk_meta["file_sizes_kb"],
            "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
        return metrics
    finally:
        if not keep_case_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run 3D bent pipe OpenFOAM case.")
    parser.add_argument("--diameter", type=float, default=50.0, help="Pipe diameter [mm]")
    parser.add_argument("--velocity", type=float, default=1.2, help="Inlet velocity [m/s]")
    parser.add_argument("--angle", type=float, default=90.0, help="Bend angle [deg]")
    parser.add_argument("--viscosity", type=float, default=1.0e-6, help="Kinematic viscosity [m^2/s]")
    parser.add_argument("--density", type=float, default=998.2, help="Density [kg/m^3]")
    parser.add_argument("--out", type=str, default="/tmp/pipe_cfd_test", help="Output directory")
    args = parser.parse_args()

    p = PipeParams(
        diameter_mm=args.diameter,
        velocity_ms=args.velocity,
        bend_angle_deg=args.angle,
        viscosity_m2s=args.viscosity,
        density_kgm3=args.density,
    )
    res = run_pipe_simulation(p, Path(args.out))
    print(json.dumps(res, indent=2))
