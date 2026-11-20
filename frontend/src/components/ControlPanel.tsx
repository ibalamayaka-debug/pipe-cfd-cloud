import React from 'react';
import { Play, Sliders, Eye, Sparkles, Droplets } from 'lucide-react';
import type { ColorMapPreset, FieldName, PipeParams, ViewSettings } from '../types';

interface ControlPanelProps {
  params: PipeParams;
  onParamsChange: (p: PipeParams) => void;
  view: ViewSettings;
  onViewChange: (v: ViewSettings) => void;
  onRun: () => void;
  loading: boolean;
}

const FLUID_PRESETS = [
  { name: '水 (20°C)', nu: 1.0e-6, rho: 998.2 },
  { name: '空气 (20°C)', nu: 1.5e-5, rho: 1.2 },
  { name: '轻质机油', nu: 5.0e-5, rho: 860.0 },
  { name: '高粘润滑油', nu: 2.0e-4, rho: 890.0 },
];

export const ControlPanel: React.FC<ControlPanelProps> = ({
  params,
  onParamsChange,
  view,
  onViewChange,
  onRun,
  loading,
}) => {
  const reEst =
    (params.velocity_ms * (params.diameter_mm * 1e-3)) / params.viscosity_m2s;
  const regimeLabel = reEst >= 2300 ? '湍流 (k-ω SST)' : '层流 (Laminar)';

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-badge">CF + Modal + OpenFOAM</div>
        <h1>PipeCFD Cloud</h1>
        <p>浏览器里的 3D 管道云仿真实验室</p>
      </div>

      {/* Section 1: Fluid & Geometry Parameters */}
      <section className="panel-section">
        <div className="section-title">
          <Sliders size={15} />
          <span>管道几何与工况参数</span>
        </div>

        <div className="fluid-pills">
          {FLUID_PRESETS.map((f) => {
            const active =
              Math.abs(params.viscosity_m2s - f.nu) / f.nu < 0.08 &&
              Math.abs(params.density_kgm3 - f.rho) < 5;
            return (
              <button
                key={f.name}
                type="button"
                className={`pill ${active ? 'active' : ''}`}
                onClick={() =>
                  onParamsChange({
                    ...params,
                    viscosity_m2s: f.nu,
                    density_kgm3: f.rho,
                  })
                }
              >
                <Droplets size={12} /> {f.name}
              </button>
            );
          })}
        </div>

        <label className="slider-row">
          <div className="slider-header">
            <span>管道内径 D</span>
            <strong>{params.diameter_mm.toFixed(0)} mm</strong>
          </div>
          <input
            type="range"
            min={20}
            max={200}
            step={10}
            value={params.diameter_mm}
            onChange={(e) =>
              onParamsChange({ ...params, diameter_mm: Number(e.target.value) })
            }
          />
        </label>

        <label className="slider-row">
          <div className="slider-header">
            <span>入口流速 U</span>
            <strong>{params.velocity_ms.toFixed(1)} m/s</strong>
          </div>
          <input
            type="range"
            min={0.2}
            max={5.0}
            step={0.2}
            value={params.velocity_ms}
            onChange={(e) =>
              onParamsChange({ ...params, velocity_ms: Number(e.target.value) })
            }
          />
        </label>

        <label className="slider-row">
          <div className="slider-header">
            <span>弯头角度 θ</span>
            <strong>{params.bend_angle_deg.toFixed(0)}°</strong>
          </div>
          <input
            type="range"
            min={30}
            max={180}
            step={15}
            value={params.bend_angle_deg}
            onChange={(e) =>
              onParamsChange({ ...params, bend_angle_deg: Number(e.target.value) })
            }
          />
        </label>

        <label className="slider-row">
          <div className="slider-header">
            <span>运动粘度 ν</span>
            <strong>{params.viscosity_m2s.toExponential(1)} m²/s</strong>
          </div>
          <input
            type="range"
            min={-6}
            max={-3.4}
            step={0.1}
            value={Math.log10(params.viscosity_m2s)}
            onChange={(e) =>
              onParamsChange({
                ...params,
                viscosity_m2s: Number(
                  Math.pow(10, Number(e.target.value)).toExponential(1)
                ),
              })
            }
          />
        </label>

        <div className="re-preview">
          <span>预估雷诺数 Re = {reEst.toFixed(0)}</span>
          <span className={`tag ${reEst >= 2300 ? 'turb' : 'lam'}`}>
            {regimeLabel}
          </span>
        </div>

        <button
          type="button"
          className="run-btn"
          disabled={loading}
          onClick={onRun}
        >
          <Play size={16} />
          {loading ? 'OpenFOAM 求解中...' : 'Run Cloud OpenFOAM'}
        </button>
      </section>

      {/* Section 2: VTK.js 3D Post-processing */}
      <section className="panel-section">
        <div className="section-title">
          <Eye size={15} />
          <span>VTK.js 3D 流场后处理</span>
        </div>

        <div className="segmented">
          {(['U_mag', 'p_Pa'] as FieldName[]).map((f) => (
            <button
              key={f}
              type="button"
              className={view.field === f ? 'active' : ''}
              onClick={() => onViewChange({ ...view, field: f })}
            >
              {f === 'U_mag' ? '速度云图 |U|' : '压力云图 p'}
            </button>
          ))}
        </div>

        <label className="select-row">
          <span>色阶配色 (Colormap)</span>
          <select
            value={view.colorMap}
            onChange={(e) =>
              onViewChange({
                ...view,
                colorMap: e.target.value as ColorMapPreset,
              })
            }
          >
            <option value="Turbo">Turbo (现代彩虹)</option>
            <option value="Cool to Warm">Cool to Warm (ParaView 经典)</option>
            <option value="Viridis">Viridis (感知均匀)</option>
            <option value="Plasma">Plasma (高对比度)</option>
          </select>
        </label>

        <div className="toggle-grid">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.showWall}
              onChange={(e) =>
                onViewChange({ ...view, showWall: e.target.checked })
              }
            />
            <span>3D 管壁云图</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.showSlice}
              onChange={(e) =>
                onViewChange({ ...view, showSlice: e.target.checked })
              }
            />
            <span>中心对称切片</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.showVectors}
              onChange={(e) =>
                onViewChange({ ...view, showVectors: e.target.checked })
              }
            />
            <span>3D 速度矢量箭头</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.wireframe}
              onChange={(e) =>
                onViewChange({ ...view, wireframe: e.target.checked })
              }
            />
            <span>管壁网格线框</span>
          </label>
        </div>

        <label className="slider-row">
          <div className="slider-header">
            <span>管壁透明度</span>
            <strong>{Math.round(view.wallOpacity * 100)}%</strong>
          </div>
          <input
            type="range"
            min={0.1}
            max={1.0}
            step={0.05}
            value={view.wallOpacity}
            onChange={(e) =>
              onViewChange({ ...view, wallOpacity: Number(e.target.value) })
            }
          />
        </label>

        <label className="slider-row">
          <div className="slider-header">
            <span>矢量箭头缩放</span>
            <strong>{view.vectorScale.toFixed(1)}×</strong>
          </div>
          <input
            type="range"
            min={0.4}
            max={2.2}
            step={0.1}
            value={view.vectorScale}
            onChange={(e) =>
              onViewChange({ ...view, vectorScale: Number(e.target.value) })
            }
          />
        </label>
      </section>

      <div className="sidebar-footer">
        <Sparkles size={13} />
        <span>已算参数自动命中 Cloudflare R2 零流量缓存</span>
      </div>
    </aside>
  );
};
