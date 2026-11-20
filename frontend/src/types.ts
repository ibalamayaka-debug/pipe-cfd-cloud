export interface PipeParams {
  diameter_mm: number;
  velocity_ms: number;
  bend_angle_deg: number;
  viscosity_m2s: number;
  density_kgm3: number;
}

export interface SimulationMetrics {
  case_key: string;
  params: PipeParams;
  kpis: {
    pressure_drop_pa: number;
    reynolds_number: number;
    dean_number: number;
    loss_coefficient_k: number;
    max_velocity_ms: number;
    flow_regime: string;
    turbulence_model: string;
    n_cells: number;
    iterations: number;
  };
  fields: {
    p_min_pa: number;
    p_max_pa: number;
    u_min_ms: number;
    u_max_ms: number;
    bounds: number[];
  };
  timing_sec: {
    mesh: number;
    solve: number;
    postprocess: number;
    total: number;
  };
  files: {
    wall: string;
    slice: string;
    vectors: string;
  };
  file_sizes_kb: {
    wall: number;
    slice: number;
    vectors: number;
  };
  computed_at: string;
}

export interface SimulationResponse {
  status: string;
  cached: boolean;
  backend: string;
  case_key: string;
  remaining_quota?: number;
  metrics: SimulationMetrics;
  urls: {
    wall: string;
    slice: string;
    vectors: string;
    metrics: string;
  };
}

export type FieldName = 'U_mag' | 'p_Pa';
export type ColorMapPreset = 'Turbo' | 'Cool to Warm' | 'Viridis' | 'Plasma';

export interface ViewSettings {
  field: FieldName;
  colorMap: ColorMapPreset;
  showWall: boolean;
  wallOpacity: number;
  showSlice: boolean;
  showVectors: boolean;
  vectorScale: number;
  wireframe: boolean;
}
