import React, { useEffect, useState } from 'react';
import {
  Activity,
  Cpu,
  Database,
  Gauge,
  Timer,
  Wind,
  AlertCircle,
} from 'lucide-react';
import { fetchCachedCases, runSimulation } from './api';
import { ControlPanel } from './components/ControlPanel';
import { VtkPipeViewer } from './components/VtkPipeViewer';
import type {
  PipeParams,
  SimulationMetrics,
  SimulationResponse,
  ViewSettings,
} from './types';

const DEFAULT_PARAMS: PipeParams = {
  diameter_mm: 50,
  velocity_ms: 1.2,
  bend_angle_deg: 90,
  viscosity_m2s: 1.0e-6,
  density_kgm3: 998.2,
};

const DEFAULT_VIEW: ViewSettings = {
  field: 'U_mag',
  colorMap: 'Turbo',
  showWall: true,
  wallOpacity: 0.35,
  showSlice: true,
  showVectors: true,
  vectorScale: 1.0,
  wireframe: false,
};

export const App: React.FC = () => {
  const [params, setParams] = useState<PipeParams>(DEFAULT_PARAMS);
  const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [cachedList, setCachedList] = useState<SimulationMetrics[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const handleRun = async (overrideParams?: PipeParams) => {
    const target = overrideParams ?? params;
    setLoading(true);
    setError('');
    try {
      const res = await runSimulation(target);
      setResult(res);
      setParams(res.metrics.params);
      const latest = await fetchCachedCases();
      setCachedList(latest);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Load any precomputed / cached cases on startup so visitors see instant 3D CFD
  useEffect(() => {
    (async () => {
      try {
        const list = await fetchCachedCases();
        setCachedList(list);
        if (list.length > 0) {
          const first = list[0];
          setParams(first.params);
          setResult({
            status: 'ok',
            cached: true,
            backend: 'cloudflare-r2-cache',
            case_key: first.case_key,
            metrics: first,
            urls: {
              wall: `/api/results/${first.case_key}/wall.vtp`,
              slice: `/api/results/${first.case_key}/slice.vtp`,
              vectors: `/api/results/${first.case_key}/vectors.vtp`,
              metrics: `/api/results/${first.case_key}/metrics.json`,
            },
          });
        }
      } catch {
        // Ignore if backend is offline on initial paint
      }
    })();
  }, []);

  const kpis = result?.metrics.kpis;
  const timing = result?.metrics.timing_sec;

  return (
    <div className="app-layout">
      <ControlPanel
        params={params}
        onParamsChange={setParams}
        view={view}
        onViewChange={setView}
        onRun={() => handleRun()}
        loading={loading}
      />

      <main className="workspace">
        {/* Top KPI Metrics Bar */}
        <header className="kpi-bar">
          <div className="kpi-card">
            <div className="kpi-label">
              <Gauge size={14} /> 进出口压降 ΔP
            </div>
            <div className="kpi-value">
              {kpis ? `${kpis.pressure_drop_pa.toFixed(1)} Pa` : '--'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <Activity size={14} /> 雷诺数 Re / 局部阻力 K
            </div>
            <div className="kpi-value">
              {kpis
                ? `${kpis.reynolds_number.toLocaleString()} · K=${kpis.loss_coefficient_k.toFixed(2)}`
                : '--'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <Wind size={14} /> 峰值流速 U_max
            </div>
            <div className="kpi-value">
              {kpis ? `${kpis.max_velocity_ms.toFixed(2)} m/s` : '--'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              <Cpu size={14} /> 网格 / 求解迭代
            </div>
            <div className="kpi-value">
              {kpis ? `${kpis.n_cells.toLocaleString()} cells · ${kpis.iterations} it` : '--'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">
              {result?.cached ? <Database size={14} /> : <Timer size={14} />}
              {result?.cached ? 'R2 缓存秒开' : 'OpenFOAM 耗时'}
            </div>
            <div className={`kpi-value ${result?.cached ? 'accent-green' : 'accent-sky'}`}>
              {result
                ? result.cached
                  ? `HIT (${timing?.total.toFixed(1)}s 原耗时)`
                  : `${timing?.total.toFixed(1)} s`
                : '--'}
            </div>
          </div>
        </header>

        {error && (
          <div className="error-banner">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* Main VTK.js 3D Viewport */}
        <div className="viewer-wrapper">
          <VtkPipeViewer result={result} view={view} loading={loading} />
        </div>

        {/* Bottom Cached Presets Strip */}
        {cachedList.length > 0 && (
          <footer className="presets-strip">
            <span className="strip-label">
              <Database size={13} /> 已缓存算例 (0ms 秒开):
            </span>
            <div className="strip-items">
              {cachedList.map((item) => {
                const active = item.case_key === result?.case_key;
                return (
                  <button
                    key={item.case_key}
                    type="button"
                    className={`case-chip ${active ? 'active' : ''}`}
                    onClick={() => handleRun(item.params)}
                  >
                    D{item.params.diameter_mm}mm · {item.params.bend_angle_deg}° ·{' '}
                    {item.params.velocity_ms}m/s · ΔP={item.kpis.pressure_drop_pa.toFixed(0)}Pa
                  </button>
                );
              })}
            </div>
          </footer>
        )}
      </main>
    </div>
  );
};
