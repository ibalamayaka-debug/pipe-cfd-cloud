import React from 'react';
import { Play, Sliders, Eye, Sparkles, Droplets } from 'lucide-react';
import { TRANSLATIONS, type Lang } from '../i18n';
import type { ColorMapPreset, FieldName, PipeParams, ViewSettings } from '../types';

interface ControlPanelProps {
  lang: Lang;
  onSetLang: (lang: Lang) => void;
  params: PipeParams;
  onParamsChange: (p: PipeParams) => void;
  view: ViewSettings;
  onViewChange: (v: ViewSettings) => void;
  onRun: () => void;
  loading: boolean;
}

const FLUID_PRESETS = [
  { key: 'water' as const, nu: 1.0e-6, rho: 998.2 },
  { key: 'air' as const, nu: 1.5e-5, rho: 1.2 },
  { key: 'lightOil' as const, nu: 5.0e-5, rho: 860.0 },
  { key: 'heavyOil' as const, nu: 2.0e-4, rho: 890.0 },
];

export const ControlPanel: React.FC<ControlPanelProps> = ({
  lang,
  onSetLang,
  params,
  onParamsChange,
  view,
  onViewChange,
  onRun,
  loading,
}) => {
  const t = TRANSLATIONS[lang];
  const reEst =
    (params.velocity_ms * (params.diameter_mm * 1e-3)) / params.viscosity_m2s;
  const regimeLabel = reEst >= 2300 ? t.regimeTurb : t.regimeLam;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-top-row">
          <div className="brand-badge">CF + Modal + OpenFOAM</div>
          <div className="lang-switch" role="group" aria-label="Language">
            <button
              type="button"
              className={lang === 'zh' ? 'active' : ''}
              onClick={() => onSetLang('zh')}
            >
              中文
            </button>
            <button
              type="button"
              className={lang === 'en' ? 'active' : ''}
              onClick={() => onSetLang('en')}
            >
              EN
            </button>
          </div>
        </div>
        <h1>PipeCFD Cloud</h1>
        <p>{t.subtitle}</p>
      </div>

      {/* Section 1: Fluid & Geometry Parameters */}
      <section className="panel-section">
        <div className="section-title">
          <Sliders size={15} />
          <span>{t.sectionParams}</span>
        </div>

        <div className="fluid-pills">
          {FLUID_PRESETS.map((f) => {
            const active =
              Math.abs(params.viscosity_m2s - f.nu) / f.nu < 0.08 &&
              Math.abs(params.density_kgm3 - f.rho) < 5;
            return (
              <button
                key={f.key}
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
                <Droplets size={12} /> {t.fluids[f.key]}
              </button>
            );
          })}
        </div>

        <label className="slider-row">
          <div className="slider-header">
            <span>{t.diameter}</span>
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
            <span>{t.velocity}</span>
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
            <span>{t.bendAngle}</span>
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
            <span>{t.viscosity}</span>
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
          <span>
            {t.reEstimate} {reEst.toFixed(0)}
          </span>
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
          {loading ? t.runningBtn : t.runBtn}
        </button>
      </section>

      {/* Section 2: VTK.js 3D Post-processing */}
      <section className="panel-section">
        <div className="section-title">
          <Eye size={15} />
          <span>{t.sectionPost}</span>
        </div>

        <div className="segmented">
          {(['U_mag', 'p_Pa'] as FieldName[]).map((f) => (
            <button
              key={f}
              type="button"
              className={view.field === f ? 'active' : ''}
              onClick={() => onViewChange({ ...view, field: f })}
            >
              {f === 'U_mag' ? t.fieldVelocity : t.fieldPressure}
            </button>
          ))}
        </div>

        <label className="select-row">
          <span>{t.colormapLabel}</span>
          <select
            value={view.colorMap}
            onChange={(e) =>
              onViewChange({
                ...view,
                colorMap: e.target.value as ColorMapPreset,
              })
            }
          >
            <option value="Turbo">{t.colormaps.Turbo}</option>
            <option value="Cool to Warm">{t.colormaps['Cool to Warm']}</option>
            <option value="Viridis">{t.colormaps.Viridis}</option>
            <option value="Plasma">{t.colormaps.Plasma}</option>
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
            <span>{t.toggleWall}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.showSlice}
              onChange={(e) =>
                onViewChange({ ...view, showSlice: e.target.checked })
              }
            />
            <span>{t.toggleSlice}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.showVectors}
              onChange={(e) =>
                onViewChange({ ...view, showVectors: e.target.checked })
              }
            />
            <span>{t.toggleVectors}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={view.wireframe}
              onChange={(e) =>
                onViewChange({ ...view, wireframe: e.target.checked })
              }
            />
            <span>{t.toggleWireframe}</span>
          </label>
        </div>

        <label className="slider-row">
          <div className="slider-header">
            <span>{t.wallOpacity}</span>
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
            <span>{t.vectorScale}</span>
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
        <span>{t.sidebarFooter}</span>
      </div>
    </aside>
  );
};
