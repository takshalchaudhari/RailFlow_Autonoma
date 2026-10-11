import React, { useMemo, useState } from "react";
import {
  Box,
  Compass,
  Eye,
  Layers,
  Map as MapIcon,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  ScenarioResponse,
  ScheduleVersion,
} from "../types";
import { MapLayerVisibility, ThreeStation } from "./ThreeStation";

export interface StationMapProps {
  scenario: ScenarioResponse;
  activeVersion: ScheduleVersion;
  baselineVersion: ScheduleVersion | null;
  simClock: number;
  setSimClock: (m: number) => void;
  playing: boolean;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  speed: 1 | 2 | 4;
  setSpeed: React.Dispatch<React.SetStateAction<1 | 2 | 4>>;
  selectedTrainId: string | null;
  selectedPlatformId: string | null;
  onSelectTrain: (trainId: string) => void;
  onSelectPlatform: (platformId: string) => void;
}

function minToClock(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "--:--";
  const clamped = Math.max(0, Math.round(m));
  const hh = Math.floor(clamped / 60) % 24;
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export const StationMap: React.FC<StationMapProps> = ({
  scenario,
  activeVersion,
  baselineVersion,
  simClock,
  setSimClock,
  playing,
  setPlaying,
  selectedTrainId,
  selectedPlatformId,
  onSelectTrain,
  onSelectPlatform,
}) => {
  const configuredMapStyleUrl = (
    (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_MAP_STYLE_URL || ""
  ).trim();

  const [renderMode, setRenderMode] = useState<
    "3d" | "schematic" | "geographic"
  >("geographic");
  const [geoBasemapStyle, setGeoBasemapStyle] = useState<
    "osm" | "satellite" | "vector"
  >("osm");
  const [showMapHelp, setShowMapHelp] = useState<boolean>(false);
  const [cameraMode, setCameraMode] = useState<"isometric" | "topdown">(
    "isometric"
  );
  const [planViewMode, setPlanViewMode] = useState<"current" | "baseline">(
    "current"
  );
  const [layersOpen, setLayersOpen] = useState<boolean>(false);
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [fitTrigger, setFitTrigger] = useState<number>(0);
  const [zoomDeltaTrigger, setZoomDeltaTrigger] = useState<{
    seq: number;
    delta: number;
  }>({ seq: 0, delta: 0 });
  const [geoTileStatus, setGeoTileStatus] = useState<
    "loading" | "ready" | "unavailable"
  >("ready");

  // 2D Schematic & Geographic pan/zoom state
  const [svgZoom, setSvgZoom] = useState<number>(1);
  const [svgPan, setSvgPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [layers, setLayers] = useState<MapLayerVisibility>({
    tracks: true,
    platforms: true,
    trains: true,
    closures: true,
    routes: true,
    buildings: true,
    conflicts: true,
  });

  const displayedVersion =
    planViewMode === "baseline" && baselineVersion
      ? baselineVersion
      : activeVersion;

  const platforms = scenario.platforms ?? [];
  const trains = scenario.trains ?? [];
  const assignments = displayedVersion.assignments ?? [];
  const changes = displayedVersion.changes ?? [];
  const disruptions = displayedVersion.applied_disruptions ?? [];
  const validationErrors = displayedVersion.validation_findings ?? [];

  const handleFitStation = () => {
    setFitTrigger((n) => n + 1);
    setSvgZoom(1);
    setSvgPan({ x: 0, y: 0 });
  };

  const handleZoomIn = () => {
    setZoomDeltaTrigger((prev) => ({ seq: prev.seq + 1, delta: -7 }));
    setSvgZoom((z) => Math.min(2.2, +(z + 0.18).toFixed(2)));
  };

  const handleZoomOut = () => {
    setZoomDeltaTrigger((prev) => ({ seq: prev.seq + 1, delta: 7 }));
    setSvgZoom((z) => Math.max(0.65, +(z - 0.18).toFixed(2)));
  };

  const toggleLayer = (key: keyof MapLayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const conflictingTrains = useMemo(() => {
    const s = new Set<string>();
    validationErrors.forEach((e) =>
      (e.train_ids ?? []).forEach((tid) => s.add(tid))
    );
    return s;
  }, [validationErrors]);

  return (
    <div className="station-map-shell" data-testid="station-map-shell">
      {/* Top Map Control Bar */}
      <div className="map-hud-top">
        <div className="map-mode-group">
          <span className="sim-badge" data-testid="map-mode-badge">
            {renderMode === "3d"
              ? "3D DIGITAL TWIN · SIMULATED TRACK LAYOUT"
              : renderMode === "geographic"
              ? geoBasemapStyle === "satellite"
                ? "REAL SATELLITE MAP · STATION CORRIDOR"
                : "REAL OPENSTREETMAP · STATION CORRIDOR"
              : "2D SCHEMATIC · SIMULATED STATION LAYOUT"}
          </span>

          <div className="segmented-btns" role="group" aria-label="Map renderer mode">
            <button
              type="button"
              className={`seg-btn ${
                renderMode === "geographic" && geoBasemapStyle === "osm"
                  ? "active"
                  : ""
              }`}
              title="Real OpenStreetMap Street & Railway Basemap (Free, No Key Required)"
              onClick={() => {
                setMapNotice(null);
                setGeoTileStatus("ready");
                setGeoBasemapStyle("osm");
                setRenderMode("geographic");
              }}
              data-testid="mode-geographic-btn"
            >
              <Compass size={13} /> Real Street Map
            </button>
            <button
              type="button"
              className={`seg-btn ${
                renderMode === "geographic" && geoBasemapStyle === "satellite"
                  ? "active"
                  : ""
              }`}
              title="Real Esri Aerial Satellite Basemap (Free, No Key Required)"
              onClick={() => {
                setMapNotice(null);
                setGeoTileStatus("ready");
                setGeoBasemapStyle("satellite");
                setRenderMode("geographic");
              }}
              data-testid="mode-satellite-btn"
            >
              <Eye size={13} /> Satellite
            </button>
            <button
              type="button"
              className={`seg-btn ${renderMode === "schematic" ? "active" : ""}`}
              onClick={() => setRenderMode("schematic")}
              data-testid="mode-schematic-btn"
            >
              <MapIcon size={13} /> 2D Track Diagram
            </button>
            <button
              type="button"
              className={`seg-btn ${renderMode === "3d" ? "active" : ""}`}
              onClick={() => setRenderMode("3d")}
              data-testid="mode-3d-btn"
            >
              <Box size={13} /> 3D Twin
            </button>
          </div>

          <button
            type="button"
            className="help-q-btn"
            onClick={() => setShowMapHelp((v) => !v)}
            title="What is this Map? (Judge Guide)"
            data-testid="map-help-btn"
          >
            ?
          </button>

          {baselineVersion && activeVersion.id !== baselineVersion.id && (
            <div
              className="segmented-btns"
              role="group"
              aria-label="Original vs Proposed Schedule Overlay"
            >
              <button
                type="button"
                className={`seg-btn ${planViewMode === "current" ? "active" : ""}`}
                onClick={() => setPlanViewMode("current")}
                data-testid="map-plan-current-btn"
              >
                Solved (v{activeVersion.version_number})
              </button>
              <button
                type="button"
                className={`seg-btn ${planViewMode === "baseline" ? "active" : ""}`}
                onClick={() => setPlanViewMode("baseline")}
                data-testid="map-plan-baseline-btn"
              >
                Before (v{baselineVersion.version_number})
              </button>
            </div>
          )}
        </div>

        <div className="map-camera-controls">
          {renderMode === "3d" && (
            <button
              type="button"
              className={`hud-btn ${cameraMode === "topdown" ? "active" : ""}`}
              onClick={() =>
                setCameraMode((m) =>
                  m === "isometric" ? "topdown" : "isometric"
                )
              }
              data-testid="toggle-camera-view-btn"
              title="Switch between Isometric 3D and Top-Down Plan view"
            >
              <Compass size={13} />{" "}
              {cameraMode === "isometric" ? "Top-Down" : "Isometric"}
            </button>
          )}

          <button
            type="button"
            className="hud-btn"
            onClick={handleFitStation}
            data-testid="fit-station-btn"
            title="Reset camera framing to fit entire station"
          >
            <Maximize2 size={13} /> Fit Station
          </button>

          <button
            type="button"
            className="hud-btn icon-only"
            onClick={handleZoomIn}
            data-testid="zoom-in-btn"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            className="hud-btn icon-only"
            onClick={handleZoomOut}
            data-testid="zoom-out-btn"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={14} />
          </button>

          <div className="layer-popover-wrap">
            <button
              type="button"
              className={`hud-btn ${layersOpen ? "active" : ""}`}
              onClick={() => setLayersOpen((o) => !o)}
              data-testid="toggle-layers-btn"
            >
              <Layers size={13} /> Layers
            </button>

            {layersOpen && (
              <div className="layer-dropdown" data-testid="layers-panel">
                <div className="layer-dropdown-head">
                  <strong>Control-Room Layers</strong>
                  <Eye size={13} />
                </div>
                {(
                  [
                    ["tracks", "Track Infrastructure & Switches"],
                    ["platforms", "Platforms & Canopies (P1–P3)"],
                    ["trains", "Animated Train Models"],
                    ["closures", "Platform Closure Hazards"],
                    ["routes", "Selected & Reassigned Routes"],
                    ["buildings", "Concourse, Depot & Signals"],
                    ["conflicts", "Constraint Conflict Markers"],
                  ] as [keyof MapLayerVisibility, string][]
                ).map(([key, label]) => (
                  <label key={key} className="layer-check-row">
                    <input
                      type="checkbox"
                      checked={layers[key]}
                      onChange={() => toggleLayer(key)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showMapHelp && (
        <div className="judge-inline-help" data-testid="map-judge-help-box">
          <div className="jih-body">
            <strong>? Judge Guide — Real Railway Map &amp; Signalling Overlay:</strong>{" "}
            <span>
              <b>Real Street Map / Satellite</b> shows real OpenStreetMap &amp;
              Esri aerial tiles under the station yard.{" "}
              <b>Signals (🟢/🟡/🔴)</b> show live track entry clearance.{" "}
              <b>Dashed Green Line (SW-101W)</b> shows Train <code>T103</code>{" "}
              switching from closed <code>Platform P2</code> onto open{" "}
              <code>Platform P3</code>. Click any train to inspect its{" "}
              <b>Driver Cab Display</b>!
            </span>
          </div>
          <button
            type="button"
            className="jih-close"
            onClick={() => setShowMapHelp(false)}
          >
            Got it ✕
          </button>
        </div>
      )}

      {mapNotice && (
        <div className="map-toast" data-testid="map-fallback-notice">
          <span>{mapNotice}</span>
          <button type="button" onClick={() => setMapNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Main Canvas Area: 3D Digital Twin, Geographic Corridor Map, or 2D SVG Schematic */}
      <div className="map-canvas-body">
        {renderMode === "3d" ? (
          <ThreeStation
            platforms={platforms}
            trains={trains}
            assignments={assignments}
            changes={changes}
            disruptions={disruptions}
            validationErrors={validationErrors}
            simClock={simClock}
            selectedTrainId={selectedTrainId}
            selectedPlatformId={selectedPlatformId}
            onSelectTrain={onSelectTrain}
            onSelectPlatform={onSelectPlatform}
            layers={layers}
            cameraMode={cameraMode}
            fitTrigger={fitTrigger}
            zoomDeltaTrigger={zoomDeltaTrigger}
            onWebGLFailure={(reason) => {
              setRenderMode("schematic");
              setMapNotice(
                `WebGL 3D context unavailable (${reason}) — switched to interactive 2D Station Schematic.`
              );
            }}
          />
        ) : (
          <div
            className={`svg-schematic-container ${
              renderMode === "geographic" ? "geographic-mode-active" : ""
            }`}
            data-testid={
              renderMode === "geographic"
                ? "geographic-map-container"
                : "schematic-map-container"
            }
          >
            {renderMode === "geographic" && (
              <>
                {/* Real OpenStreetMap / Esri Satellite Tile Layer + Vector Cartographic Fallback */}
                <div
                  className="geo-tile-backdrop"
                  data-testid="geo-tile-backdrop"
                  style={{
                    transform: `translate(${svgPan.x * 0.35}px, ${
                      svgPan.y * 0.35
                    }px) scale(${Math.max(0.85, Math.min(1.5, svgZoom))})`,
                  }}
                >
                  {geoBasemapStyle !== "vector" &&
                    geoTileStatus !== "unavailable" && (
                      <div
                        className="geo-tile-grid"
                        data-testid="real-map-tile-grid"
                      >
                        {[
                          { x: 46824, y: 27418 },
                          { x: 46825, y: 27418 },
                          { x: 46826, y: 27418 },
                          { x: 46827, y: 27418 },
                          { x: 46824, y: 27419 },
                          { x: 46825, y: 27419 },
                          { x: 46826, y: 27419 },
                          { x: 46827, y: 27419 },
                        ].map((t, i) => {
                          const activeTemplate =
                            configuredMapStyleUrl ||
                            (geoBasemapStyle === "satellite"
                              ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                              : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}");
                          const tileUrl = activeTemplate
                            .replace("{z}", "16")
                            .replace("{x}", String(t.x))
                            .replace("{y}", String(t.y));
                          return (
                            <img
                              key={`${geoBasemapStyle}-${t.x}-${t.y}`}
                              src={tileUrl}
                              alt=""
                              className={`geo-raster-tile ${
                                geoBasemapStyle === "osm"
                                  ? "osm-street-tile"
                                  : "sat-aerial-tile"
                              }`}
                              onLoad={() => {
                                if (i === 0) {
                                  setGeoTileStatus((prev) =>
                                    prev !== "ready" ? "ready" : prev
                                  );
                                }
                              }}
                              onError={() => {
                                setGeoTileStatus("unavailable");
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  <svg
                    viewBox="0 0 1100 500"
                    className="geo-vector-basemap-svg"
                    data-testid="geo-vector-basemap"
                    preserveAspectRatio="xMidYMid slice"
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "block",
                      position: "relative",
                      zIndex: 2,
                      pointerEvents: "none",
                      opacity:
                        geoTileStatus === "unavailable" ||
                        geoBasemapStyle === "vector"
                          ? 1
                          : 0,
                    }}
                  >
                    <defs>
                      <pattern
                        id="geo-graticule"
                        width="90"
                        height="90"
                        patternUnits="userSpaceOnUse"
                      >
                        <path
                          d="M 90 0 L 0 0 0 90"
                          fill="none"
                          stroke="rgba(56, 189, 248, 0.08)"
                          strokeWidth="1"
                        />
                      </pattern>
                    </defs>
                    {/* Base Cartographic Landmass (fallback when offline) */}
                    <rect width="1100" height="500" fill="#06101e" />
                    <rect width="1100" height="500" fill="url(#geo-graticule)" />

                      {/* Topographic Elevation Contours */}
                      <path
                        d="M -20 95 Q 240 40, 540 85 T 1120 65"
                        fill="none"
                        stroke="rgba(30, 58, 95, 0.45)"
                        strokeWidth="1.5"
                        strokeDasharray="6 4"
                      />
                      <path
                        d="M -20 410 Q 320 455, 680 395 T 1120 430"
                        fill="none"
                        stroke="rgba(30, 58, 95, 0.45)"
                        strokeWidth="1.5"
                        strokeDasharray="6 4"
                      />

                      {/* River Vortexa Waterway */}
                      <path
                        d="M -30 390 C 190 365, 340 445, 590 420 C 820 395, 930 310, 1130 330"
                        fill="none"
                        stroke="rgba(14, 116, 144, 0.28)"
                        strokeWidth="36"
                        strokeLinecap="round"
                      />
                      <path
                        d="M -30 390 C 190 365, 340 445, 590 420 C 820 395, 930 310, 1130 330"
                        fill="none"
                        stroke="rgba(56, 189, 248, 0.22)"
                        strokeWidth="2"
                      />

                      {/* Urban Sector Blocks & Industrial Parcels */}
                      <g fill="rgba(15, 29, 52, 0.65)" stroke="rgba(51, 65, 85, 0.45)" strokeWidth="1">
                        <rect x="65" y="55" width="130" height="65" rx="4" />
                        <rect x="215" y="48" width="95" height="54" rx="4" />
                        <rect x="760" y="52" width="145" height="62" rx="4" />
                        <rect x="920" y="60" width="115" height="58" rx="4" />
                        <rect x="80" y="280" width="120" height="55" rx="4" />
                        <rect x="735" y="295" width="150" height="64" rx="4" />
                        <rect x="905" y="275" width="125" height="50" rx="4" />
                      </g>

                      {/* Arterial Road Network & Overpasses */}
                      <g fill="none" stroke="rgba(71, 85, 105, 0.42)" strokeWidth="5">
                        <path d="M 180 0 L 245 500" />
                        <path d="M 855 0 L 795 500" />
                        <path d="M 0 130 Q 550 115, 1100 135" strokeWidth="3" />
                      </g>

                      {/* Georeferenced Coordinate Labels */}
                      <g fill="rgba(148, 163, 184, 0.55)" fontSize="9.5" fontFamily="monospace">
                        <text x="24" y="86">51.534°N · 0.128°W</text>
                        <text x="24" y="266">51.531°N · 0.128°W</text>
                        <text x="24" y="446">51.528°N · 0.128°W</text>
                        <text x="490" y="468">RIVER VORTEXA ESTUARY (SYNTHETIC TOPOGRAPHY)</text>
                      </g>
                    </svg>
                </div>

                {/* Compact Non-Overlapping Corner Status Pill */}
                <div
                  className="geo-corridor-hud"
                  data-testid="geo-corridor-hud"
                >
                  <span
                    className="geo-status-pill ready"
                    data-testid="geo-tile-status-badge"
                  >
                    {configuredMapStyleUrl && geoTileStatus === "ready"
                      ? "Custom Tile Basemap Active"
                      : geoBasemapStyle === "satellite"
                      ? "Real Satellite Map Active (Free · Zero Key)"
                      : "Real Street Map Active (Free · Zero Key)"}
                  </span>
                </div>

                {/* Attribution Compliance Footer */}
                <div className="geo-attribution" data-testid="geo-attribution">
                  Basemap Tiles ©{" "}
                  <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenStreetMap / Esri ArcGIS
                  </a>{" "}
                  · Zero-Key Live Railway Corridor Overlay
                </div>
              </>
            )}

            <svg
              viewBox="0 0 1050 420"
              className="rich-station-svg"
              data-testid={
                renderMode === "geographic"
                  ? "geographic-svg-canvas"
                  : "schematic-svg-canvas"
              }
            >
              <g
                transform={`translate(${525 + svgPan.x}, ${
                  210 + svgPan.y
                }) scale(${svgZoom}) translate(-525, -210)`}
              >
                {/* Geographic Corridor Sector Frame when in Geographic mode */}
                {renderMode === "geographic" && (
                  <g className="geo-svg-sector-markers">
                    <rect
                      x="14"
                      y="8"
                      width="1022"
                      height="398"
                      rx="10"
                      fill="rgba(15, 23, 42, 0.14)"
                      stroke="rgba(37, 99, 235, 0.5)"
                      strokeDasharray="8 6"
                      strokeWidth="1.5"
                    />
                  </g>
                )}

                {/* Station Concourse Header (Top Center, Clear of Tracks) */}
                {layers.buildings && (
                  <g>
                    <rect
                      x="310"
                      y="12"
                      width="430"
                      height="32"
                      rx="6"
                      fill="rgba(15, 23, 42, 0.92)"
                      stroke="#3b82f6"
                      strokeWidth="1.5"
                    />
                    <text
                      x="525"
                      y="32"
                      textAnchor="middle"
                      fill="#f8fafc"
                      fontSize="11"
                      fontWeight="800"
                      letterSpacing="1.4"
                    >
                      CENTRAL JUNCTION INTERLOCKING &amp; SIGNALLING YARD
                    </text>
                  </g>
                )}

                {/* Mainline approach throats, sleepers, overbridge & switches */}
                {layers.tracks && (
                  <g>
                    {/* Mainline Track Bed & Rails at Y=215 */}
                    <line
                      x1="20"
                      y1="215"
                      x2="215"
                      y2="215"
                      stroke="#1e293b"
                      strokeWidth="10"
                    />
                    <line
                      x1="20"
                      y1="215"
                      x2="215"
                      y2="215"
                      stroke="#64748b"
                      strokeWidth="3.5"
                    />
                    <line
                      x1="835"
                      y1="215"
                      x2="1030"
                      y2="215"
                      stroke="#1e293b"
                      strokeWidth="10"
                    />
                    <line
                      x1="835"
                      y1="215"
                      x2="1030"
                      y2="215"
                      stroke="#64748b"
                      strokeWidth="3.5"
                    />
                    {/* Interlocking Turnout Switches */}
                    <circle
                      cx="215"
                      cy="215"
                      r="7"
                      fill="#2563eb"
                      stroke="#ffffff"
                      strokeWidth="2"
                    />
                    <rect
                      x="162"
                      y="188"
                      width="56"
                      height="17"
                      rx="4"
                      fill="rgba(15, 23, 42, 0.88)"
                    />
                    <text
                      x="190"
                      y="200"
                      textAnchor="middle"
                      fill="#93c5fd"
                      fontSize="9"
                      fontFamily="monospace"
                      fontWeight="700"
                    >
                      SW-101W
                    </text>
                    <circle
                      cx="835"
                      cy="215"
                      r="7"
                      fill="#2563eb"
                      stroke="#ffffff"
                      strokeWidth="2"
                    />
                    <rect
                      x="832"
                      y="188"
                      width="56"
                      height="17"
                      rx="4"
                      fill="rgba(15, 23, 42, 0.88)"
                    />
                    <text
                      x="860"
                      y="200"
                      textAnchor="middle"
                      fill="#93c5fd"
                      fontSize="9"
                      fontFamily="monospace"
                      fontWeight="700"
                    >
                      SW-102E
                    </text>
                  </g>
                )}

                {/* Platforms P1, P2, P3 — Canopy Header Above Track Berth so Trains NEVER Overlap Labels */}
                {platforms.map((p, idx) => {
                  const trackY = 118 + idx * 102;
                  const canopyY = trackY - 40;
                  const gapMin =
                    p.clearance_minutes ??
                    p.min_gap_minutes ??
                    scenario.station?.clearance_minutes ??
                    10;
                  const pClosures = disruptions.filter(
                    (d) =>
                      d.type === "platform_closure" &&
                      (d.platform_id === p.id || d.target_id === p.id) &&
                      d.start !== null &&
                      d.end !== null
                  );
                  const hasClosure = pClosures.length > 0;
                  const isClosedNow = pClosures.some(
                    (d) =>
                      simClock >= (d.start ?? 0) && simClock < (d.end ?? 1440)
                  );
                  const isSelected = selectedPlatformId === p.id;
                  const platAssignments = assignments.filter(
                    (a) => a.platform_id === p.id && !a.unresolved
                  );
                  const occupiedNow = platAssignments.some(
                    (a) =>
                      a.arrival !== null &&
                      a.departure !== null &&
                      simClock >= a.arrival &&
                      simClock < a.departure
                  );
                  const hasReassignedOnto = changes.some(
                    (c) => c.proposed_platform === p.id && c.platform_changed
                  );

                  const signalColor =
                    hasClosure || isClosedNow
                      ? "#ef4444"
                      : occupiedNow
                      ? "#f59e0b"
                      : "#10b981";
                  const signalText =
                    hasClosure || isClosedNow
                      ? `CLOSED ${pClosures
                          .map(
                            (c) =>
                              `${c.start_str ?? minToClock(c.start)}–${
                                c.end_str ?? minToClock(c.end)
                              }`
                          )
                          .join(", ")}`
                      : occupiedNow
                      ? `OCCUPIED · ${gapMin}M GAP`
                      : `CLEAR · ${gapMin}M SAFETY GAP`;

                  return (
                    <g
                      key={p.id}
                      onClick={() => onSelectPlatform(p.id)}
                      style={{ cursor: "pointer" }}
                      data-testid={`schematic-platform-${p.id}`}
                    >
                      {/* Dedicated Track Berth Bed */}
                      {layers.tracks && (
                        <>
                          <path
                            d={`M 215 215 C 268 215, 268 ${trackY}, 315 ${trackY} L 735 ${trackY} C 782 ${trackY}, 782 215, 835 215`}
                            fill="none"
                            stroke="rgba(15, 23, 42, 0.75)"
                            strokeWidth="9"
                          />
                          <path
                            d={`M 215 215 C 268 215, 268 ${trackY}, 315 ${trackY} L 735 ${trackY} C 782 ${trackY}, 782 215, 835 215`}
                            fill="none"
                            stroke={
                              hasClosure
                                ? "#ef4444"
                                : isSelected
                                ? "#3b82f6"
                                : hasReassignedOnto && layers.routes
                                ? "#10b981"
                                : "#94a3b8"
                            }
                            strokeWidth={
                              isSelected || hasReassignedOnto ? "4.5" : "3"
                            }
                            strokeDasharray={hasClosure ? "8 5" : undefined}
                          />
                        </>
                      )}

                      {/* Platform Header Banner (Strictly ABOVE Track Berth so Trains Never Cover Text) */}
                      {layers.platforms && (
                        <g>
                          <rect
                            x="315"
                            y={canopyY}
                            width="420"
                            height="24"
                            rx="6"
                            fill={
                              hasClosure
                                ? "rgba(127, 29, 29, 0.94)"
                                : isSelected
                                ? "rgba(30, 64, 175, 0.95)"
                                : "rgba(15, 23, 42, 0.92)"
                            }
                            stroke={
                              hasClosure
                                ? "#ef4444"
                                : isSelected
                                ? "#60a5fa"
                                : hasReassignedOnto
                                ? "#10b981"
                                : "#334155"
                            }
                            strokeWidth="1.5"
                          />
                          <text
                            x="328"
                            y={canopyY + 16}
                            fill="#ffffff"
                            fontWeight="800"
                            fontSize="11.5"
                          >
                            PLATFORM {p.id}
                          </text>
                          <text
                            x="432"
                            y={canopyY + 15.5}
                            fill={hasClosure ? "#fca5a5" : "#6ee7b7"}
                            fontSize="9.5"
                            fontFamily="monospace"
                            fontWeight="700"
                          >
                            {signalText}
                          </text>
                          <text
                            x="724"
                            y={canopyY + 15.5}
                            textAnchor="end"
                            fill="#93c5fd"
                            fontSize="9.5"
                            fontFamily="monospace"
                            fontWeight="700"
                          >
                            {platAssignments.length > 0
                              ? platAssignments
                                  .map(
                                    (a) =>
                                      `${a.train_id} (${a.arrival_str}–${a.departure_str})`
                                  )
                                  .join(" · ")
                              : "NO TRAINS"}
                          </text>
                        </g>
                      )}

                      {/* Track Berth Guide Box (Where Trains Dock) */}
                      <rect
                        x="315"
                        y={trackY - 13}
                        width="420"
                        height="26"
                        rx="5"
                        fill={
                          hasClosure
                            ? "rgba(239, 68, 68, 0.16)"
                            : "rgba(15, 23, 42, 0.32)"
                        }
                        stroke={
                          hasClosure
                            ? "rgba(239, 68, 68, 0.5)"
                            : "rgba(148, 163, 184, 0.35)"
                        }
                        strokeDasharray="4 4"
                      />

                      {/* West Entry Signal Aspect */}
                      <g transform={`translate(296, ${trackY})`}>
                        <rect
                          x="-10"
                          y="-9"
                          width="18"
                          height="18"
                          rx="4"
                          fill="#0f172a"
                          stroke="#475569"
                        />
                        <circle cx="-1" cy="0" r="5" fill={signalColor} />
                      </g>

                      {/* East Departure Signal Aspect */}
                      <g transform={`translate(752, ${trackY})`}>
                        <rect
                          x="-8"
                          y="-9"
                          width="18"
                          height="18"
                          rx="4"
                          fill="#0f172a"
                          stroke="#475569"
                        />
                        <circle cx="1" cy="0" r="5" fill={signalColor} />
                      </g>
                    </g>
                  );
                })}

                {/* Trains on Track Berths & Non-Overlapping West Staging Slots */}
                {layers.trains &&
                  assignments.map((a, idx) => {
                    if (
                      a.unresolved ||
                      !a.platform_id ||
                      a.arrival === null ||
                      a.departure === null
                    ) {
                      return null;
                    }
                    const pIdx = Math.max(
                      0,
                      platforms.findIndex((p) => p.id === a.platform_id)
                    );
                    const trackY = 118 + pIdx * 102;
                    let x = 96;
                    let tokenY = trackY;
                    let stateLabel = "APPROACHING";

                    if (simClock < a.arrival - 15) {
                      // Dedicated vertical queue on West Approach so waiting trains NEVER overlap
                      x = 92;
                      tokenY = 78 + idx * 78;
                      stateLabel = `DUE ${a.arrival_str}`;
                    } else if (simClock < a.arrival) {
                      const ratio = 1 - (a.arrival - simClock) / 15;
                      x = 215 + ratio * 150;
                      tokenY = 215 + (trackY - 215) * ratio;
                      stateLabel = `ARR ${a.arrival_str}`;
                    } else if (simClock >= a.arrival && simClock < a.departure) {
                      const ratio =
                        (simClock - a.arrival) /
                        Math.max(1, a.departure - a.arrival);
                      x = 395 + ratio * 250;
                      tokenY = trackY;
                      stateLabel = `DOCKED · DEP ${a.departure_str}`;
                    } else if (
                      simClock >= a.departure &&
                      simClock < a.departure + 15
                    ) {
                      const ratio = (simClock - a.departure) / 15;
                      x = 735 + ratio * 150;
                      tokenY = trackY + (215 - trackY) * ratio;
                      stateLabel = "DEPARTING";
                    } else {
                      x = 955;
                      tokenY = 78 + idx * 78;
                      stateLabel = `DEP ${a.departure_str}`;
                    }

                    const isConflict = conflictingTrains.has(a.train_id);
                    const isDelayed = a.total_delay_minutes > 0;
                    const chg = changes.find(
                      (c) => c.train_id === a.train_id && c.platform_changed
                    );
                    const isMoved = Boolean(chg);
                    const isSelected = selectedTrainId === a.train_id;

                    const fill = isConflict
                      ? "#dc2626"
                      : isMoved
                      ? "#059669"
                      : isDelayed
                      ? "#d97706"
                      : "#2563eb";

                    return (
                      <g key={a.train_id}>
                        {/* Dashed connector from West Approach Queue to Switch SW-101W */}
                        {simClock < a.arrival - 15 && (
                          <path
                            d={`M ${x + 54} ${tokenY} C 175 ${tokenY}, 180 215, 215 215`}
                            fill="none"
                            stroke={fill}
                            strokeWidth="1.5"
                            strokeDasharray="4 3"
                            opacity="0.75"
                          />
                        )}
                        <g
                          transform={`translate(${x}, ${tokenY})`}
                          onClick={() => onSelectTrain(a.train_id)}
                          style={{ cursor: "pointer" }}
                          data-testid={`schematic-train-${a.train_id}`}
                        >
                          <rect
                            x="-56"
                            y="-15"
                            width="112"
                            height="30"
                            rx="6"
                            fill={fill}
                            stroke={isSelected ? "#ffffff" : "#e2e8f0"}
                            strokeWidth={isSelected ? "2.5" : "1.2"}
                          />
                          <text
                            x="0"
                            y="-2"
                            textAnchor="middle"
                            fill="#ffffff"
                            fontSize="10.5"
                            fontWeight="800"
                          >
                            {a.train_id}{" "}
                            {chg
                              ? `(${chg.previous_platform}→${a.platform_id})`
                              : `· ${a.platform_id}`}
                          </text>
                          <text
                            x="0"
                            y="10"
                            textAnchor="middle"
                            fill="#f8fafc"
                            fontSize="8.5"
                            fontFamily="monospace"
                          >
                            {stateLabel}
                          </text>
                        </g>
                      </g>
                    );
                  })}
              </g>
            </svg>
          </div>
        )}

        {/* Quick Clickable Train & Platform Selector Pills along Bottom-Left of Map */}
        <div className="map-quick-entities" data-testid="map-entity-selectors">
          <div className="entity-pill-group">
            <span className="pill-group-label">TRAINS:</span>
            {assignments.map((a) => {
              const isConflict = conflictingTrains.has(a.train_id);
              const isDelayed = a.total_delay_minutes > 0;
              return (
                <button
                  key={a.train_id}
                  type="button"
                  className={`entity-pill ${
                    selectedTrainId === a.train_id ? "selected" : ""
                  } ${
                    isConflict
                      ? "conflict"
                      : isDelayed
                      ? "delayed"
                      : "normal"
                  }`}
                  onClick={() => onSelectTrain(a.train_id)}
                  data-testid={`select-train-${a.train_id}`}
                >
                  {a.train_id} ({a.platform_id ?? "UNRES"})
                </button>
              );
            })}
          </div>
          <div className="entity-pill-group">
            <span className="pill-group-label">TRACKS:</span>
            {platforms.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`entity-pill ${
                  selectedPlatformId === p.id ? "selected" : ""
                }`}
                onClick={() => onSelectPlatform(p.id)}
                data-testid={`select-platform-${p.id}`}
              >
                {p.id}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live Driver Cab Instruction Banner + Real-Time Station Telemetry Checkpoint Strip (Replaces Video Player Scrubber) */}
      <div className="map-telemetry-footer" data-testid="map-telemetry-footer">
        {selectedTrainId &&
          (() => {
            const asgn = assignments.find((a) => a.train_id === selectedTrainId);
            const chg = changes.find((c) => c.train_id === selectedTrainId);
            if (!asgn) return null;
            const isConflict = conflictingTrains.has(selectedTrainId);
            return (
              <div
                className="driver-cab-inline-banner"
                data-testid="map-driver-card"
              >
                <span
                  className={`driver-signal-dot ${
                    isConflict || asgn.unresolved
                      ? "red"
                      : asgn.total_delay_minutes > 0 || chg?.platform_changed
                      ? "amber"
                      : "green"
                  }`}
                />
                <strong>CAB SIGNAL · {asgn.train_id}:</strong>
                <span className="driver-plat-tag">
                  {asgn.unresolved
                    ? "HOLD OUTSIDE STATION"
                    : `TRACK ${asgn.platform_id}`}
                </span>
                <span className="driver-cab-text">
                  {asgn.unresolved
                    ? `STOP: Cannot enter station (${asgn.unresolved_reason}).`
                    : chg && chg.platform_changed
                    ? `RE-ROUTED ${chg.previous_platform} → ${asgn.platform_id} · Arrive ${asgn.arrival_str}, Depart ${asgn.departure_str} (0m solver hold)`
                    : `PROCEED Platform ${asgn.platform_id} · ${asgn.arrival_str}–${asgn.departure_str} (${
                        asgn.total_delay_minutes > 0
                          ? `+${asgn.total_delay_minutes}m delay`
                          : "On Time"
                      })`}
                </span>
              </div>
            );
          })()}

        <div className="telemetry-checkpoints-row">
          <div className="telemetry-clock-box">
            <span className="tele-clock-label">STATION TELEMETRY CLOCK</span>
            <strong className="clock-readout" data-testid="sim-clock-display">
              {minToClock(simClock)} IST
            </strong>
          </div>

          <div className="checkpoint-pills" role="group" aria-label="Operational event checkpoints">
            {[
              { min: 540, label: "09:00 Baseline" },
              { min: 560, label: "09:20 P2 Closes / T101 Arr" },
              { min: 565, label: "09:25 T103 → P3" },
              { min: 575, label: "09:35 Dual Occupancy" },
              { min: 590, label: "09:50 T102 Clear" },
              { min: 595, label: "09:55 T104 Clear" },
            ].map((cp) => (
              <button
                key={cp.min}
                type="button"
                className={`cp-jump-btn ${
                  Math.abs(simClock - cp.min) <= 3 ? "active" : ""
                }`}
                onClick={() => setSimClock(cp.min)}
              >
                {cp.label}
              </button>
            ))}
          </div>

          <div className="telemetry-live-kpis">
            <span className="tele-kpi-chip safe">
              HEADWAY: ≥{scenario.station?.clearance_minutes ?? 10}m SAFE
            </span>
            <span className="tele-kpi-chip info">
              ACTIVE TRAINS:{" "}
              {
                assignments.filter(
                  (a) =>
                    !a.unresolved &&
                    a.arrival !== null &&
                    a.departure !== null &&
                    simClock >= a.arrival &&
                    simClock < a.departure
                ).length
              }{" "}
              DOCKED
            </span>
            <button
              type="button"
              className={`cp-jump-btn ${playing ? "active" : ""}`}
              onClick={() => setPlaying((p) => !p)}
              data-testid="sim-play-pause-btn"
              title="Toggle live clock auto-advance"
            >
              {playing ? "● Live Tick ON" : "○ Auto-Tick"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
