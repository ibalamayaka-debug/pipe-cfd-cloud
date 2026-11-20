import React, { useCallback, useEffect, useRef, useState } from 'react';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/Profiles/Glyph';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkGlyph3DMapper from '@kitware/vtk.js/Rendering/Core/Glyph3DMapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkArrowSource from '@kitware/vtk.js/Filters/Sources/ArrowSource';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkColorMaps from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction/ColorMaps';
import { ColorMode, ScalarMode } from '@kitware/vtk.js/Rendering/Core/Mapper/Constants';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor';
import { Compass, RotateCcw, Box, Layers } from 'lucide-react';
import { fetchBinary } from '../api';
import type { ColorMapPreset, SimulationResponse, ViewSettings } from '../types';

interface VtkPipeViewerProps {
  result: SimulationResponse | null;
  view: ViewSettings;
  loading: boolean;
}

const COLORBAR_GRADIENTS: Record<ColorMapPreset, string> = {
  Turbo:
    'linear-gradient(90deg, #1b4f9c 0%, #26a9e0 25%, #5fd38d 50%, #f5c342 75%, #c92a2a 100%)',
  'Cool to Warm':
    'linear-gradient(90deg, #3b4cc0 0%, #7b9ff9 25%, #dddcdc 50%, #f4987a 75%, #b40426 100%)',
  Viridis:
    'linear-gradient(90deg, #440154 0%, #3b528b 25%, #21918c 50%, #5ec962 75%, #fde725 100%)',
  Plasma:
    'linear-gradient(90deg, #0d0887 0%, #6a00a8 25%, #b12a90 50%, #e16462 75%, #f0f921 100%)',
};

const VTK_PRESET_MAP: Record<ColorMapPreset, string> = {
  Turbo: 'Rainbow Desaturated',
  'Cool to Warm': 'Cool to Warm',
  Viridis: 'Viridis (matplotlib)',
  Plasma: 'Plasma (matplotlib)',
};

function resolvePreset(name: ColorMapPreset) {
  const mapped = VTK_PRESET_MAP[name] || name;
  return (
    vtkColorMaps.getPresetByName(mapped) ||
    vtkColorMaps.getPresetByName('Cool to Warm')
  );
}

interface VtkSceneHandle {
  genericRW: ReturnType<typeof vtkGenericRenderWindow.newInstance>;
  wallActor: ReturnType<typeof vtkActor.newInstance>;
  wallMapper: ReturnType<typeof vtkMapper.newInstance>;
  sliceActor: ReturnType<typeof vtkActor.newInstance>;
  sliceMapper: ReturnType<typeof vtkMapper.newInstance>;
  glyphActor: ReturnType<typeof vtkActor.newInstance>;
  glyphMapper: ReturnType<typeof vtkGlyph3DMapper.newInstance>;
  lut: ReturnType<typeof vtkColorTransferFunction.newInstance>;
  glyphLut: ReturnType<typeof vtkColorTransferFunction.newInstance>;
  orientWidget: ReturnType<typeof vtkOrientationMarkerWidget.newInstance> | null;
  bounds: number[];
  dataLoaded: boolean;
}

export const VtkPipeViewer: React.FC<VtkPipeViewerProps> = ({
  result,
  view,
  loading,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<VtkSceneHandle | null>(null);
  const viewRef = useRef<ViewSettings>(view);
  viewRef.current = view;

  const [meshStatus, setMeshStatus] = useState<string>('');
  const [scalarRange, setScalarRange] = useState<[number, number]>([0, 1]);

  const applyViewToScene = useCallback(
    (scene: VtkSceneHandle, currentResult: SimulationResponse, v: ViewSettings) => {
      if (!scene.dataLoaded) return;

      const { fields, params } = currentResult.metrics;
      const isPressure = v.field === 'p_Pa';
      const minVal = isPressure ? fields.p_min_pa : fields.u_min_ms;
      const maxVal = isPressure ? fields.p_max_pa : Math.max(fields.u_max_ms, 0.01);
      setScalarRange([minVal, maxVal]);

      const preset = resolvePreset(v.colorMap);
      scene.lut.applyColorMap(preset);
      scene.lut.setMappingRange(minVal, maxVal);
      scene.lut.updateRange();

      const uMax = Math.max(fields.u_max_ms, 0.01);
      scene.glyphLut.applyColorMap(preset);
      scene.glyphLut.setMappingRange(fields.u_min_ms, uMax);
      scene.glyphLut.updateRange();

      // Wall surface
      scene.wallMapper.setColorByArrayName(v.field);
      scene.wallMapper.setScalarRange(minVal, maxVal);
      scene.wallActor.setVisibility(v.showWall);
      scene.wallActor.getProperty().setOpacity(v.wallOpacity);
      scene.wallActor.getProperty().setRepresentation(v.wireframe ? 1 : 2);

      // Center symmetry slice
      scene.sliceMapper.setColorByArrayName(v.field);
      scene.sliceMapper.setScalarRange(minVal, maxVal);
      scene.sliceActor.setVisibility(v.showSlice);

      // 3D velocity vector arrows
      const pipeD = params.diameter_mm * 1e-3;
      const baseArrowLen = (pipeD * 0.42) / uMax;
      scene.glyphMapper.setScaleFactor(baseArrowLen * v.vectorScale);
      scene.glyphMapper.setScalarRange(fields.u_min_ms, uMax);
      scene.glyphActor.setVisibility(v.showVectors);

      scene.genericRW.getRenderWindow().render();
    },
    []
  );

  const setCameraPreset = useCallback((preset: 'iso' | 'xy' | 'xz') => {
    const scene = sceneRef.current;
    if (!scene) return;
    const renderer = scene.genericRW.getRenderer();
    const camera = renderer.getActiveCamera();
    const b = scene.bounds;
    const cx = 0.5 * (b[0] + b[1]);
    const cy = 0.5 * (b[2] + b[3]);
    const cz = 0.5 * (b[4] + b[5]);
    const diag = Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) || 0.3;

    camera.setFocalPoint(cx, cy, cz);
    if (preset === 'xy') {
      camera.setPosition(cx, cy, cz + diag * 1.45);
      camera.setViewUp(0, 1, 0);
    } else if (preset === 'xz') {
      camera.setPosition(cx, cy - diag * 1.45, cz);
      camera.setViewUp(0, 0, 1);
    } else {
      camera.setPosition(cx + diag * 0.65, cy - diag * 0.75, cz + diag * 1.05);
      camera.setViewUp(0, 1, 0);
    }
    renderer.resetCameraClippingRange();
    scene.genericRW.getRenderWindow().render();
  }, []);

  // 1. Initialize VTK.js WebGL render window once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    const genericRW = vtkGenericRenderWindow.newInstance({
      background: [0.045, 0.062, 0.098],
    });
    genericRW.setContainer(el);
    genericRW.resize();

    const renderer = genericRW.getRenderer();
    const interactor = genericRW.getInteractor();

    const lut = vtkColorTransferFunction.newInstance();
    lut.applyColorMap(resolvePreset('Turbo'));

    const glyphLut = vtkColorTransferFunction.newInstance();
    glyphLut.applyColorMap(resolvePreset('Turbo'));

    // Pipe outer wall surface (hidden until .vtp loads)
    const wallMapper = vtkMapper.newInstance();
    wallMapper.setLookupTable(lut);
    wallMapper.setColorMode(ColorMode.MAP_SCALARS);
    wallMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    wallMapper.setScalarVisibility(true);
    const wallActor = vtkActor.newInstance();
    wallActor.setMapper(wallMapper);
    wallActor.setVisibility(false);
    wallActor.getProperty().setSpecular(0.25);
    wallActor.getProperty().setSpecularPower(24);
    wallActor.getProperty().setAmbient(0.25);
    wallActor.getProperty().setDiffuse(0.75);
    renderer.addActor(wallActor);

    // Center symmetry slice (z=0)
    const sliceMapper = vtkMapper.newInstance();
    sliceMapper.setLookupTable(lut);
    sliceMapper.setColorMode(ColorMode.MAP_SCALARS);
    sliceMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    sliceMapper.setScalarVisibility(true);
    const sliceActor = vtkActor.newInstance();
    sliceActor.setMapper(sliceMapper);
    sliceActor.setVisibility(false);
    sliceActor.getProperty().setAmbient(0.35);
    sliceActor.getProperty().setDiffuse(0.65);
    renderer.addActor(sliceActor);

    // 3D velocity vector arrows
    const arrowSource = vtkArrowSource.newInstance({
      tipLength: 0.35,
      tipRadius: 0.14,
      shaftRadius: 0.045,
      tipResolution: 12,
      shaftResolution: 10,
    });
    const glyphMapper = vtkGlyph3DMapper.newInstance({
      orient: true,
      scaling: true,
    });
    glyphMapper.setInputConnection(arrowSource.getOutputPort(), 1);
    glyphMapper.setOrientationArray('U');
    glyphMapper.setOrientationModeToDirection();
    glyphMapper.setScaleArray('U_mag');
    glyphMapper.setScaleModeToScaleByMagnitude();
    glyphMapper.setLookupTable(glyphLut);
    glyphMapper.setColorMode(ColorMode.MAP_SCALARS);
    glyphMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    glyphMapper.setColorByArrayName('U_mag');
    glyphMapper.setScalarVisibility(true);

    const glyphActor = vtkActor.newInstance();
    glyphActor.setMapper(glyphMapper);
    glyphActor.setVisibility(false);
    renderer.addActor(glyphActor);

    // Render initial blank frame so active camera & canvas dimensions exist
    renderer.resetCamera();
    genericRW.getRenderWindow().render();

    // ParaView-style orientation cube in bottom-right corner
    let orientWidget: ReturnType<typeof vtkOrientationMarkerWidget.newInstance> | null =
      null;
    try {
      const cube = vtkAnnotatedCubeActor.newInstance();
      cube.setDefaultStyle({
        text: '+X',
        fontStyle: 'bold',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontColor: '#f8fafc',
        fontSizeScale: (res: number) => res / 2.2,
        faceColor: '#1e293b',
        edgeThickness: 0.12,
        edgeColor: '#38bdf8',
        resolution: 256,
      });
      cube.setXPlusFaceProperty({ text: '+X' });
      cube.setXMinusFaceProperty({ text: '-X' });
      cube.setYPlusFaceProperty({ text: '+Y' });
      cube.setYMinusFaceProperty({ text: '-Y' });
      cube.setZPlusFaceProperty({ text: '+Z' });
      cube.setZMinusFaceProperty({ text: '-Z' });

      orientWidget = vtkOrientationMarkerWidget.newInstance({
        actor: cube,
        interactor,
        parentRenderer: renderer,
        viewportCorner: vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT,
        viewportSize: 0.16,
        minPixelSize: 80,
        maxPixelSize: 120,
      });
      orientWidget.setEnabled(true);
    } catch (err) {
      console.warn('Orientation marker widget disabled:', err);
      orientWidget = null;
    }

    sceneRef.current = {
      genericRW,
      wallActor,
      wallMapper,
      sliceActor,
      sliceMapper,
      glyphActor,
      glyphMapper,
      lut,
      glyphLut,
      orientWidget,
      bounds: [-0.1, 0.1, -0.1, 0.1, -0.05, 0.05],
      dataLoaded: false,
    };

    const ro = new ResizeObserver(() => {
      if (!disposed) {
        genericRW.resize();
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      if (orientWidget) {
        try {
          orientWidget.setEnabled(false);
          orientWidget.delete();
        } catch {
          // Ignore teardown errors
        }
      }
      try {
        genericRW.delete();
      } catch {
        // Ignore teardown errors
      }
      sceneRef.current = null;
    };
  }, []);

  // 2. Load .vtp results from Cloudflare R2 / local server whenever simulation changes
  useEffect(() => {
    if (!result || !sceneRef.current) return;
    let cancelled = false;

    const loadAll = async () => {
      setMeshStatus('正在加载 3D 流场 (.vtp)...');
      try {
        const [wallBuf, sliceBuf, vecBuf] = await Promise.all([
          fetchBinary(result.urls.wall),
          fetchBinary(result.urls.slice),
          fetchBinary(result.urls.vectors),
        ]);
        if (cancelled || !sceneRef.current) return;

        const parseVtp = (buf: ArrayBuffer) => {
          const reader = vtkXMLPolyDataReader.newInstance();
          reader.parseAsArrayBuffer(buf);
          return reader.getOutputData(0);
        };

        const wallPoly = parseVtp(wallBuf);
        const slicePoly = parseVtp(sliceBuf);
        const vecPoly = parseVtp(vecBuf);

        const scene = sceneRef.current;
        scene.wallMapper.setInputData(wallPoly);
        scene.sliceMapper.setInputData(slicePoly);
        scene.glyphMapper.setInputData(vecPoly, 0);
        scene.bounds = wallPoly.getBounds();
        scene.dataLoaded = true;

        applyViewToScene(scene, result, viewRef.current);
        setCameraPreset('iso');
        setMeshStatus('');
      } catch (err) {
        if (!cancelled) {
          setMeshStatus(`加载 3D 数据失败: ${(err as Error).message}`);
        }
      }
    };

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [result, applyViewToScene, setCameraPreset]);

  // 3. Apply live visualization settings (colormap, active field, opacity, toggles)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !result || !scene.dataLoaded) return;
    applyViewToScene(scene, result, view);
  }, [result, view, applyViewToScene]);

  const unit = view.field === 'p_Pa' ? 'Pa' : 'm/s';
  const fieldLabel = view.field === 'p_Pa' ? '相对静压 p' : '速度幅值 |U|';
  const midVal = 0.5 * (scalarRange[0] + scalarRange[1]);

  return (
    <div className="viewer-shell">
      <div ref={containerRef} className="vtk-canvas" />

      {/* Top-left camera toolbar */}
      <div className="viewer-toolbar">
        <button onClick={() => setCameraPreset('iso')} title="3D 等轴测视角">
          <Box size={14} /> 3D ISO
        </button>
        <button onClick={() => setCameraPreset('xy')} title="XY 弯管主平面">
          <Layers size={14} /> XY 平面
        </button>
        <button onClick={() => setCameraPreset('xz')} title="XZ 侧视图">
          <Compass size={14} /> XZ 侧视
        </button>
        <button onClick={() => setCameraPreset('iso')} title="重置相机">
          <RotateCcw size={14} /> 重置
        </button>
      </div>

      {/* Bottom-left Colorbar Legend */}
      {result && (
        <div className="colorbar-card">
          <div className="colorbar-header">
            <span>{fieldLabel}</span>
            <span className="colorbar-unit">{unit}</span>
          </div>
          <div
            className="colorbar-strip"
            style={{ background: COLORBAR_GRADIENTS[view.colorMap] }}
          />
          <div className="colorbar-ticks">
            <span>{scalarRange[0].toFixed(view.field === 'p_Pa' ? 1 : 2)}</span>
            <span>{midVal.toFixed(view.field === 'p_Pa' ? 1 : 2)}</span>
            <span>{scalarRange[1].toFixed(view.field === 'p_Pa' ? 1 : 2)}</span>
          </div>
        </div>
      )}

      {/* Interaction hint */}
      <div className="viewer-hint">左键 360° 旋转 · 滚轮缩放 · Shift+左键平移</div>

      {/* Loading / empty overlay */}
      {(loading || meshStatus || !result) && (
        <div className="viewer-overlay">
          {loading ? (
            <div className="spinner-card">
              <div className="spinner" />
              <h3>正在运行云端 OpenFOAM 求解器...</h3>
              <p>blockMesh O-Grid 网格划分 → simpleFoam 迭代收敛 → VTK 流场抽取</p>
            </div>
          ) : meshStatus ? (
            <div className="spinner-card">
              <div className="spinner" />
              <h3>{meshStatus}</h3>
            </div>
          ) : (
            <div className="spinner-card">
              <h3>调整左侧管道参数并点击“运行云仿真”</h3>
              <p>基于真实 OpenFOAM 3D 求解 + VTK.js WebGL 渲染</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
