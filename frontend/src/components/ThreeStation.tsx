import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  Platform,
  ScheduleAssignment,
  ScheduleChange,
  ScheduleDisruption,
  Train,
  ValidationErrorItem,
} from "../types";

export interface MapLayerVisibility {
  tracks: boolean;
  platforms: boolean;
  trains: boolean;
  closures: boolean;
  routes: boolean;
  buildings: boolean;
  conflicts: boolean;
}

export interface ThreeStationProps {
  platforms: Platform[];
  trains: Train[];
  assignments: ScheduleAssignment[];
  changes: ScheduleChange[];
  disruptions: ScheduleDisruption[];
  validationErrors: ValidationErrorItem[];
  simClock: number;
  selectedTrainId: string | null;
  selectedPlatformId: string | null;
  onSelectTrain: (trainId: string) => void;
  onSelectPlatform: (platformId: string) => void;
  layers: MapLayerVisibility;
  cameraMode: "isometric" | "topdown";
  geoBasemapStyle?: "osm" | "satellite" | "vector";
  fitTrigger: number;
  zoomDeltaTrigger: { seq: number; delta: number };
  onWebGLFailure?: (reason: string) => void;
}

function minToClock(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "--:--";
  const clamped = Math.max(0, Math.round(m));
  const hh = Math.floor(clamped / 60) % 24;
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function createBadgeTexture(
  title: string,
  subtitle: string,
  accentHex: string,
  bgHex = "rgba(8, 17, 34, 0.92)"
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 280;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 280, 96);
    ctx.fillStyle = bgHex;
    ctx.beginPath();
    ctx.roundRect(6, 6, 268, 84, 14);
    ctx.fill();

    ctx.lineWidth = 4;
    ctx.strokeStyle = accentHex;
    ctx.stroke();

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 28px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(title, 140, 44);

    ctx.fillStyle = accentHex;
    ctx.font = "700 19px JetBrains Mono, monospace";
    ctx.fillText(subtitle, 140, 74);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates a 2048x1024 geospatial ground texture with real OpenStreetMap / Esri
 * map tiles stitched onto the 3D ground plane, plus immediate high-detail
 * cartographic corridor roads, river, sector blocks, and lat/lon graticule.
 */
function createRealGeoGroundTexture(
  style: "osm" | "satellite" | "vector"
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;

  const drawFallbackCartography = () => {
    if (!ctx) return;
    const isSat = style === "satellite";
    ctx.fillStyle = isSat ? "#0f241d" : "#e2e8f0";
    ctx.fillRect(0, 0, 2048, 1024);

    // Subtle urban blocks & parklands
    ctx.fillStyle = isSat ? "rgba(20, 83, 45, 0.45)" : "#dcfce7";
    ctx.fillRect(80, 70, 520, 240);
    ctx.fillRect(1420, 680, 520, 260);

    // River Vortexa Estuary
    ctx.strokeStyle = isSat ? "#0284c7" : "#38bdf8";
    ctx.lineWidth = 68;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 860);
    ctx.bezierCurveTo(520, 790, 980, 950, 1520, 850);
    ctx.bezierCurveTo(1780, 800, 1920, 740, 2048, 760);
    ctx.stroke();

    // Arterial Road Network
    ctx.strokeStyle = isSat ? "rgba(148, 163, 184, 0.45)" : "#cbd5e1";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(380, 0);
    ctx.lineTo(490, 1024);
    ctx.moveTo(1620, 0);
    ctx.lineTo(1510, 1024);
    ctx.moveTo(0, 210);
    ctx.lineTo(2048, 230);
    ctx.stroke();

    // Graticule grid
    ctx.strokeStyle = isSat
      ? "rgba(56, 189, 248, 0.16)"
      : "rgba(37, 99, 235, 0.14)";
    ctx.lineWidth = 2;
    for (let x = 0; x <= 2048; x += 128) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 1024);
      ctx.stroke();
    }
    for (let y = 0; y <= 1024; y += 128) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(2048, y);
      ctx.stroke();
    }
    tex.needsUpdate = true;
  };

  drawFallbackCartography();

  if (style !== "vector" && ctx) {
    const tiles = [
      { x: 46824, y: 27418, col: 0, row: 0 },
      { x: 46825, y: 27418, col: 1, row: 0 },
      { x: 46826, y: 27418, col: 2, row: 0 },
      { x: 46827, y: 27418, col: 3, row: 0 },
      { x: 46824, y: 27419, col: 0, row: 1 },
      { x: 46825, y: 27419, col: 1, row: 1 },
      { x: 46826, y: 27419, col: 2, row: 1 },
      { x: 46827, y: 27419, col: 3, row: 1 },
    ];
    const template =
      style === "satellite"
        ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/16/{y}/{x}"
        : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/16/{y}/{x}";

    tiles.forEach((t) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        ctx.drawImage(img, t.col * 512, t.row * 512, 512, 512);
        // Subtle railway corridor tint & grid overlay so 3D tracks pop clearly
        ctx.fillStyle =
          style === "satellite"
            ? "rgba(6, 16, 30, 0.22)"
            : "rgba(15, 23, 42, 0.08)";
        ctx.fillRect(t.col * 512, t.row * 512, 512, 512);
        ctx.strokeStyle = "rgba(37, 99, 235, 0.22)";
        ctx.lineWidth = 2;
        ctx.strokeRect(t.col * 512, t.row * 512, 512, 512);
        tex.needsUpdate = true;
      };
      img.src = template
        .replace("{x}", String(t.x))
        .replace("{y}", String(t.y));
    });
  }

  return tex;
}

function buildPlatformCurve(zOffset: number): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(-48, 0.35, 0),
    new THREE.Vector3(-30, 0.35, 0),
    new THREE.Vector3(-19, 0.35, zOffset),
    new THREE.Vector3(0, 0.35, zOffset),
    new THREE.Vector3(19, 0.35, zOffset),
    new THREE.Vector3(30, 0.35, 0),
    new THREE.Vector3(48, 0.35, 0),
  ]);
}

export const ThreeStation: React.FC<ThreeStationProps> = ({
  platforms,
  assignments,
  changes,
  disruptions,
  validationErrors,
  simClock,
  selectedTrainId,
  selectedPlatformId,
  onSelectTrain,
  onSelectPlatform,
  layers,
  cameraMode,
  geoBasemapStyle = "osm",
  fitTrigger,
  zoomDeltaTrigger,
  onWebGLFailure,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const groundMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const [webglReady, setWebglReady] = useState<boolean>(true);
  const [localGeoStyle, setLocalGeoStyle] = useState<"osm" | "satellite">(
    geoBasemapStyle === "satellite" ? "satellite" : "osm"
  );

  useEffect(() => {
    if (geoBasemapStyle === "satellite" || geoBasemapStyle === "osm") {
      setLocalGeoStyle(geoBasemapStyle);
    }
  }, [geoBasemapStyle]);

  // Update 3D ground plane texture whenever localGeoStyle changes
  useEffect(() => {
    if (groundMatRef.current) {
      const newTex = createRealGeoGroundTexture(localGeoStyle);
      groundMatRef.current.map = newTex;
      groundMatRef.current.color.setHex(0xffffff);
      groundMatRef.current.needsUpdate = true;
    }
  }, [localGeoStyle]);

  // Spherical camera state for smooth Orbit + Pan + Zoom
  const camSpherical = useRef({
    radius: 56,
    theta: 0.34,
    phi: 0.88,
    target: new THREE.Vector3(0, 0, 0),
  });

  // Keep latest props in a ref for animation frame & picking loop
  const latestProps = useRef({
    platforms,
    assignments,
    changes,
    disruptions,
    validationErrors,
    simClock,
    selectedTrainId,
    selectedPlatformId,
    onSelectTrain,
    onSelectPlatform,
    layers,
  });
  latestProps.current = {
    platforms,
    assignments,
    changes,
    disruptions,
    validationErrors,
    simClock,
    selectedTrainId,
    selectedPlatformId,
    onSelectTrain,
    onSelectPlatform,
    layers,
  };

  // Switch between Isometric and Top-Down camera angles
  useEffect(() => {
    if (cameraMode === "topdown") {
      camSpherical.current.phi = 0.08;
      camSpherical.current.theta = 0;
      camSpherical.current.radius = 52;
    } else {
      camSpherical.current.phi = 0.88;
      camSpherical.current.theta = 0.34;
      camSpherical.current.radius = 56;
    }
  }, [cameraMode]);

  // Fit Station reset
  useEffect(() => {
    if (fitTrigger === 0) return;
    camSpherical.current.target.set(0, 0, 0);
    if (cameraMode === "topdown") {
      camSpherical.current.phi = 0.08;
      camSpherical.current.theta = 0;
      camSpherical.current.radius = 52;
    } else {
      camSpherical.current.phi = 0.88;
      camSpherical.current.theta = 0.34;
      camSpherical.current.radius = 56;
    }
  }, [fitTrigger, cameraMode]);

  // Explicit Zoom In / Out button triggers
  useEffect(() => {
    if (zoomDeltaTrigger.seq === 0) return;
    camSpherical.current.radius = Math.max(
      20,
      Math.min(110, camSpherical.current.radius + zoomDeltaTrigger.delta)
    );
  }, [zoomDeltaTrigger]);

  // Focus camera gently when a platform is selected
  useEffect(() => {
    if (!selectedPlatformId) return;
    const idx = platforms.findIndex((p) => p.id === selectedPlatformId);
    if (idx >= 0) {
      const zOffset = (idx - (platforms.length - 1) / 2) * 9.5;
      camSpherical.current.target.set(0, 0, zOffset * 0.55);
    }
  }, [selectedPlatformId, platforms]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch (err) {
      setWebglReady(false);
      onWebGLFailure?.(
        err instanceof Error ? err.message : "WebGL context creation failed"
      );
      return;
    }

    const width = Math.max(mount.clientWidth, 640);
    const height = Math.max(mount.clientHeight, 420);
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(0x0b172a, 0);

    // Clear any stale child canvas from Strict Mode remounts
    mount.innerHTML = "";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("data-testid", "three-station-canvas");
    mount.appendChild(renderer.domElement);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      setWebglReady(false);
      onWebGLFailure?.("WebGL context lost");
    };
    renderer.domElement.addEventListener(
      "webglcontextlost",
      handleContextLost,
      false
    );

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.5, 320);

    // Lighting
    const ambient = new THREE.AmbientLight(0xdbeafe, 1.35);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xf0f9ff, 0x1e293b, 1.05);
    hemi.position.set(0, 55, 0);
    scene.add(hemi);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(28, 48, 24);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 5;
    dirLight.shadow.camera.far = 140;
    const d = 50;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    scene.add(dirLight);

    // Real Geospatial Ground Plane (OpenStreetMap / Esri Satellite Stitched Texture)
    const groundGeo = new THREE.PlaneGeometry(165, 92);
    const initialTex = createRealGeoGroundTexture(localGeoStyle);
    const groundMat = new THREE.MeshStandardMaterial({
      map: initialTex,
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.06,
    });
    groundMatRef.current = groundMat;
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Subtle railway yard coordinate grid slightly above ground
    const grid = new THREE.GridHelper(156, 36, 0x2563eb, 0x475569);
    grid.position.y = 0.03;
    const gridMat = grid.material as THREE.Material;
    if (gridMat) {
      gridMat.transparent = true;
      gridMat.opacity = 0.24;
    }
    scene.add(grid);

    // Scene Layer Groups
    const tracksGroup = new THREE.Group();
    const platformsGroup = new THREE.Group();
    const buildingsGroup = new THREE.Group();
    const closuresGroup = new THREE.Group();
    const routesGroup = new THREE.Group();
    const trainsGroup = new THREE.Group();

    scene.add(tracksGroup);
    scene.add(platformsGroup);
    scene.add(buildingsGroup);
    scene.add(closuresGroup);
    scene.add(routesGroup);
    scene.add(trainsGroup);

    // Build static Tracks, Sleepers, Turnout Switches, Catenary Portals & Platforms
    const currentPlatforms = latestProps.current.platforms;
    const platformCurves = new Map<string, THREE.CatmullRomCurve3>();
    const platformSignalLights = new Map<string, THREE.Mesh>();

    const railMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      metalness: 0.82,
      roughness: 0.25,
    });
    const sleeperMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.85,
    });
    const ballastMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.95,
    });

    // West & East Interlocking Switch Nodes (SW-101W & SW-102E)
    [
      { x: -30, id: "SW-101W", sub: "WEST APPROACH SWITCH" },
      { x: 30, id: "SW-102E", sub: "EAST DEPARTURE SWITCH" },
    ].forEach((sw) => {
      const swDisk = new THREE.Mesh(
        new THREE.CylinderGeometry(1.15, 1.15, 0.28, 20),
        new THREE.MeshStandardMaterial({
          color: 0x2563eb,
          emissive: 0x1d4ed8,
          emissiveIntensity: 0.4,
        })
      );
      swDisk.position.set(sw.x, 0.22, 0);
      tracksGroup.add(swDisk);

      const swTex = createBadgeTexture(
        sw.id,
        sw.sub,
        "#60a5fa",
        "rgba(15, 23, 42, 0.92)"
      );
      const swSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: swTex, depthTest: false })
      );
      swSprite.position.set(sw.x, 3.2, 0);
      swSprite.scale.set(5.2, 1.8, 1);
      tracksGroup.add(swSprite);
    });

    currentPlatforms.forEach((plat, idx) => {
      const zOffset = (idx - (currentPlatforms.length - 1) / 2) * 9.5;
      const curve = buildPlatformCurve(zOffset);
      platformCurves.set(plat.id, curve);

      // Ballast bed along curve
      const points = curve.getSpacedPoints(74);
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const tangent = curve.getTangent(i / (points.length - 1));
        const angle = Math.atan2(tangent.z, tangent.x);

        // Sleeper
        const sleeper = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 0.14, 2.2),
          sleeperMat
        );
        sleeper.position.set(pt.x, 0.09, pt.z);
        sleeper.rotation.y = -angle;
        tracksGroup.add(sleeper);
      }

      // Twin steel rails along curve
      [-0.65, 0.65].forEach((railOffset) => {
        const offsetPts = points.map((pt, i) => {
          const t = curve.getTangent(i / (points.length - 1));
          const normal = new THREE.Vector3(-t.z, 0, t.x).normalize();
          return pt
            .clone()
            .add(normal.multiplyScalar(railOffset))
            .setY(0.24);
        });
        const railCurve = new THREE.CatmullRomCurve3(offsetPts);
        const railGeo = new THREE.TubeGeometry(railCurve, 68, 0.075, 6, false);
        const railMesh = new THREE.Mesh(railGeo, railMat);
        tracksGroup.add(railMesh);
      });

      // Ballast strip under platform track
      const ballast = new THREE.Mesh(
        new THREE.BoxGeometry(42, 0.12, 2.9),
        ballastMat
      );
      ballast.position.set(0, 0.06, zOffset);
      tracksGroup.add(ballast);

      // Platform Deck (positioned immediately North of the track at zOffset - 2.95)
      const platZ = zOffset - 2.95;
      const platGroup = new THREE.Group();
      platGroup.userData = { platformId: plat.id };

      const deckMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.6,
        metalness: 0.18,
      });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(36, 0.9, 3.1), deckMat);
      deck.position.set(0, 0.45, platZ);
      deck.castShadow = true;
      deck.receiveShadow = true;
      deck.userData = { platformId: plat.id };
      platGroup.add(deck);

      // Yellow safety tactile edge strip
      const safetyStrip = new THREE.Mesh(
        new THREE.BoxGeometry(36, 0.06, 0.24),
        new THREE.MeshBasicMaterial({ color: 0xfacc15 })
      );
      safetyStrip.position.set(0, 0.92, platZ + 1.4);
      safetyStrip.userData = { platformId: plat.id };
      platGroup.add(safetyStrip);

      // Platform Canopy & Support Columns
      const canopyMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        metalness: 0.5,
        roughness: 0.35,
        transparent: true,
        opacity: 0.9,
      });
      const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(28, 0.22, 2.8),
        canopyMat
      );
      canopy.position.set(0, 3.6, platZ);
      canopy.castShadow = true;
      canopy.userData = { platformId: plat.id };
      platGroup.add(canopy);

      // Cyan LED strip under canopy
      const ledStrip = new THREE.Mesh(
        new THREE.BoxGeometry(26, 0.05, 0.18),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
      );
      ledStrip.position.set(0, 3.46, platZ + 0.9);
      platGroup.add(ledStrip);

      [-11, -4, 4, 11].forEach((colX) => {
        const col = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.14, 2.7, 10),
          railMat
        );
        col.position.set(colX, 2.2, platZ - 0.5);
        col.userData = { platformId: plat.id };
        platGroup.add(col);
      });

      // Platform Sign Sprite (PLATFORM P1, P2, P3)
      const signTex = createBadgeTexture(
        `PLATFORM ${plat.id}`,
        `CLEARANCE ≥${plat.clearance_minutes ?? plat.min_gap_minutes ?? 10}M`,
        "#38bdf8"
      );
      const signSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: signTex, depthTest: false })
      );
      signSprite.position.set(-14.5, 5.1, platZ);
      signSprite.scale.set(5.2, 1.8, 1);
      signSprite.userData = { platformId: plat.id };
      platGroup.add(signSprite);

      // Trackside Departure Signal at East end of platform
      const sigPost = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 2.6, 8),
        sleeperMat
      );
      sigPost.position.set(19.2, 1.3, zOffset - 1.35);
      buildingsGroup.add(sigPost);

      const sigHead = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.95, 0.45),
        new THREE.MeshStandardMaterial({ color: 0x090d16 })
      );
      sigHead.position.set(19.2, 2.65, zOffset - 1.35);
      buildingsGroup.add(sigHead);

      const sigLamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x10b981 })
      );
      sigLamp.position.set(19.45, 2.65, zOffset - 1.35);
      buildingsGroup.add(sigLamp);
      platformSignalLights.set(plat.id, sigLamp);

      platformsGroup.add(platGroup);
    });

    // Overhead Electrification Catenary Portals
    [-22, -8, 8, 22].forEach((portalX) => {
      const mastMat = new THREE.MeshStandardMaterial({
        color: 0x475569,
        metalness: 0.6,
        roughness: 0.4,
      });
      const leftMast = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 6.2, 0.28),
        mastMat
      );
      leftMast.position.set(portalX, 3.1, -15);
      const rightMast = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 6.2, 0.28),
        mastMat
      );
      rightMast.position.set(portalX, 3.1, 14);
      const crossBeam = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.25, 29.4),
        mastMat
      );
      crossBeam.position.set(portalX, 6.0, -0.5);
      buildingsGroup.add(leftMast, rightMast, crossBeam);
    });

    // Central Station Main Concourse Building & Control Tower (North side)
    const stationBuilding = new THREE.Group();
    const mainHall = new THREE.Mesh(
      new THREE.BoxGeometry(32, 5.2, 7.5),
      new THREE.MeshStandardMaterial({
        color: 0x0f1e36,
        metalness: 0.35,
        roughness: 0.45,
      })
    );
    mainHall.position.set(0, 2.6, -20.5);
    mainHall.castShadow = true;
    mainHall.receiveShadow = true;
    stationBuilding.add(mainHall);

    // Illuminated Glass Concourse Windows
    const glassFront = new THREE.Mesh(
      new THREE.BoxGeometry(29, 3.2, 0.2),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.36,
      })
    );
    glassFront.position.set(0, 2.4, -16.7);
    stationBuilding.add(glassFront);

    // Control Tower
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(6.5, 9.5, 5.5),
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        metalness: 0.4,
        roughness: 0.4,
      })
    );
    tower.position.set(12, 4.75, -20.5);
    tower.castShadow = true;
    stationBuilding.add(tower);

    const towerGlass = new THREE.Mesh(
      new THREE.BoxGeometry(6.7, 1.8, 5.7),
      new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.55,
      })
    );
    towerGlass.position.set(12, 8.1, -20.5);
    stationBuilding.add(towerGlass);

    buildingsGroup.add(stationBuilding);

    // Mouse / Pointer interaction for Orbit, Pan, Wheel Zoom, and Object Picking
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let isDragging = false;
    let isRightDrag = false;
    let downX = 0;
    let downY = 0;
    let prevX = 0;
    let prevY = 0;

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      isRightDrag = e.button === 2 || e.shiftKey;
      downX = e.clientX;
      downY = e.clientY;
      prevX = e.clientX;
      prevY = e.clientY;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      prevX = e.clientX;
      prevY = e.clientY;

      if (isRightDrag) {
        const panScale = camSpherical.current.radius * 0.0015;
        camSpherical.current.target.x = Math.max(
          -35,
          Math.min(35, camSpherical.current.target.x - dx * panScale)
        );
        camSpherical.current.target.z = Math.max(
          -25,
          Math.min(25, camSpherical.current.target.z - dy * panScale)
        );
      } else {
        camSpherical.current.theta -= dx * 0.0065;
        camSpherical.current.phi = Math.max(
          0.08,
          Math.min(1.42, camSpherical.current.phi - dy * 0.0065)
        );
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      const movedDist = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (movedDist > 6) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);

      const trainHits = raycaster.intersectObjects(trainsGroup.children, true);
      for (const hit of trainHits) {
        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          if (obj.userData?.trainId) {
            latestProps.current.onSelectTrain(obj.userData.trainId);
            return;
          }
          obj = obj.parent;
        }
      }

      let closestTrainId: string | null = null;
      let closestTrainDist = 38;
      trainsGroup.children.forEach((tGroup) => {
        const tid = tGroup.userData?.trainId;
        if (!tid) return;
        const worldPos = new THREE.Vector3();
        tGroup.getWorldPosition(worldPos);
        worldPos.project(camera);
        const sx = ((worldPos.x + 1) * rect.width) / 2 + rect.left;
        const sy = ((-worldPos.y + 1) * rect.height) / 2 + rect.top;
        const dPx = Math.hypot(e.clientX - sx, e.clientY - sy);
        if (dPx < closestTrainDist) {
          closestTrainDist = dPx;
          closestTrainId = tid;
        }
      });
      if (closestTrainId) {
        latestProps.current.onSelectTrain(closestTrainId);
        return;
      }

      const platHits = raycaster.intersectObjects(
        platformsGroup.children,
        true
      );
      for (const hit of platHits) {
        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          if (obj.userData?.platformId) {
            latestProps.current.onSelectPlatform(obj.userData.platformId);
            return;
          }
          obj = obj.parent;
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camSpherical.current.radius = Math.max(
        20,
        Math.min(110, camSpherical.current.radius + e.deltaY * 0.03)
      );
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    const domEl = renderer.domElement;
    domEl.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    domEl.addEventListener("wheel", onWheel, { passive: false });
    domEl.addEventListener("contextmenu", onContextMenu);

    const handleResize = () => {
      if (!mount) return;
      const w = Math.max(mount.clientWidth, 400);
      const h = Math.max(mount.clientHeight, 320);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObs = new ResizeObserver(handleResize);
    resizeObs.observe(mount);

    let lastDynamicSignature = "";

    const syncDynamicObjects = () => {
      const {
        platforms: plats,
        assignments: asgns,
        changes: chgs,
        disruptions: disrs,
        validationErrors: valErrs,
        simClock: clock,
        selectedTrainId: selTid,
        selectedPlatformId: selPid,
        layers: vis,
      } = latestProps.current;

      tracksGroup.visible = vis.tracks;
      platformsGroup.visible = vis.platforms;
      buildingsGroup.visible = vis.buildings;
      closuresGroup.visible = vis.closures;
      routesGroup.visible = vis.routes;
      trainsGroup.visible = vis.trains;

      const sig = JSON.stringify({
        asgns: asgns.map((a) => [
          a.train_id,
          a.platform_id,
          a.arrival,
          a.departure,
          a.total_delay_minutes,
          a.unresolved,
        ]),
        disrs: disrs.map((d) => [d.id, d.platform_id, d.start, d.end]),
        valErrs: valErrs.map((v) => [v.code, v.platform_id, v.train_ids]),
        clock: Math.round(clock * 2) / 2,
        selTid,
        selPid,
        vis,
      });

      if (sig === lastDynamicSignature) return;
      lastDynamicSignature = sig;

      const clearGroup = (grp: THREE.Group) => {
        while (grp.children.length > 0) {
          const child = grp.children[0];
          grp.remove(child);
        }
      };
      clearGroup(closuresGroup);
      clearGroup(routesGroup);
      clearGroup(trainsGroup);

      // 1. Update Platform Closures, Signals & Active Platform Route Tubes
      plats.forEach((plat, idx) => {
        const zOffset = (idx - (plats.length - 1) / 2) * 9.5;
        const pClosures = disrs.filter(
          (d) =>
            d.type === "platform_closure" &&
            (d.platform_id === plat.id || d.target_id === plat.id) &&
            d.start !== null &&
            d.end !== null
        );
        const hasConflictOnPlat = valErrs.some(
          (err) => err.platform_id === plat.id
        );
        const hasReassignedOnto = chgs.some(
          (c) => c.proposed_platform === plat.id && c.platform_changed
        );

        const sigLamp = platformSignalLights.get(plat.id);
        if (sigLamp) {
          const mat = sigLamp.material as THREE.MeshBasicMaterial;
          if (pClosures.length > 0 || hasConflictOnPlat) {
            mat.color.setHex(0xef4444);
          } else {
            mat.color.setHex(0x10b981);
          }
        }

        // Draw Full-Corridor 3D Active Route Tube on every platform
        const curve = platformCurves.get(plat.id);
        if (curve) {
          const isClosedPlat = pClosures.length > 0;
          const routeColor = isClosedPlat
            ? 0xef4444
            : hasReassignedOnto
            ? 0x10b981
            : selPid === plat.id
            ? 0x3b82f6
            : 0x38bdf8;
          const routeRadius =
            hasReassignedOnto || selPid === plat.id ? 0.24 : 0.14;
          const routeGeo = new THREE.TubeGeometry(
            curve,
            68,
            routeRadius,
            8,
            false
          );
          const routeMat = new THREE.MeshBasicMaterial({
            color: routeColor,
            transparent: true,
            opacity: isClosedPlat ? 0.55 : hasReassignedOnto ? 0.85 : 0.45,
          });
          routesGroup.add(new THREE.Mesh(routeGeo, routeMat));

          if (hasReassignedOnto) {
            const movedTrain = chgs.find(
              (c) => c.proposed_platform === plat.id && c.platform_changed
            );
            const routeTex = createBadgeTexture(
              `BYPASS ROUTE → ${plat.id}`,
              `${movedTrain?.train_id ?? "T103"} SWITCHED ${
                movedTrain?.previous_platform ?? "P2"
              }→${plat.id} (0M HOLD)`,
              "#34d399",
              "rgba(6, 78, 59, 0.94)"
            );
            const routeSprite = new THREE.Sprite(
              new THREE.SpriteMaterial({ map: routeTex, depthTest: false })
            );
            routeSprite.position.set(-22, 2.8, zOffset * 0.65);
            routeSprite.scale.set(6.4, 2.0, 1);
            routesGroup.add(routeSprite);
          }
        }

        if (pClosures.length > 0) {
          const c = pClosures[0];
          const isClosedNow =
            c.start !== null &&
            c.end !== null &&
            clock >= c.start &&
            clock < c.end;

          const hazardGroup = new THREE.Group();
          hazardGroup.userData = { platformId: plat.id };

          const hazardBox = new THREE.Mesh(
            new THREE.BoxGeometry(36, 1.5, 4.2),
            new THREE.MeshBasicMaterial({
              color: 0xef4444,
              transparent: true,
              opacity: isClosedNow ? 0.34 : 0.2,
            })
          );
          hazardBox.position.set(0, 0.85, zOffset - 1.1);
          hazardGroup.add(hazardBox);

          [-17.5, 17.5].forEach((bx) => {
            const barrier = new THREE.Mesh(
              new THREE.BoxGeometry(0.6, 1.1, 2.2),
              new THREE.MeshStandardMaterial({ color: 0xdc2626 })
            );
            barrier.position.set(bx, 0.65, zOffset);
            hazardGroup.add(barrier);
          });

          const closureTex = createBadgeTexture(
            `${plat.id} CLOSED`,
            `${c.start_str ?? minToClock(c.start)}–${
              c.end_str ?? minToClock(c.end)
            }`,
            "#f87171",
            "rgba(69, 10, 10, 0.94)"
          );
          const closureSprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: closureTex, depthTest: false })
          );
          closureSprite.position.set(0, 4.8, zOffset);
          closureSprite.scale.set(6.2, 2.2, 1);
          hazardGroup.add(closureSprite);

          closuresGroup.add(hazardGroup);
        }
      });

      // 2. Build Trains along their assigned routes without any overlap
      const conflictingTrains = new Set<string>();
      valErrs.forEach((err) => {
        (err.train_ids ?? []).forEach((t) => conflictingTrains.add(t));
      });

      // Sort trains per platform by arrival time so waiting trains are spaced cleanly
      const platOrderMap = new Map<string, number>();
      plats.forEach((p) => {
        const pTrains = asgns
          .filter((a) => a.platform_id === p.id && !a.unresolved)
          .sort((a, b) => (a.arrival ?? 0) - (b.arrival ?? 0));
        pTrains.forEach((t, orderIdx) => platOrderMap.set(t.train_id, orderIdx));
      });

      asgns.forEach((a) => {
        if (
          a.unresolved ||
          !a.platform_id ||
          a.arrival === null ||
          a.departure === null
        ) {
          return;
        }
        const curve = platformCurves.get(a.platform_id);
        if (!curve) return;

        const orderOnPlat = platOrderMap.get(a.train_id) ?? 0;

        // Calculate non-overlapping normalized parameter u along track spline
        let u = 0.5;
        let stateLabel = "DOCKED";
        if (clock < a.arrival) {
          // Stagger approaching/waiting trains cleanly along West Approach [0.08 .. 0.28]
          u = Math.max(0.06, 0.24 - orderOnPlat * 0.14);
          stateLabel = `ARR ${a.arrival_str}`;
        } else if (clock >= a.arrival && clock < a.departure) {
          const ratio =
            (clock - a.arrival) / Math.max(1, a.departure - a.arrival);
          u = 0.44 + ratio * 0.14;
          stateLabel = `DEP ${a.departure_str}`;
        } else {
          u = Math.min(0.94, 0.8 + orderOnPlat * 0.12);
          stateLabel = "CLEARED";
        }

        const chg = chgs.find((c) => c.train_id === a.train_id);
        const isConflict = conflictingTrains.has(a.train_id);
        const isDelayed = a.total_delay_minutes > 0;
        const isMoved = Boolean(chg?.platform_changed);
        const isSelected = selTid === a.train_id;

        const bodyColor = isConflict
          ? 0xdc2626
          : isMoved
          ? 0x10b981
          : isDelayed
          ? 0xd97706
          : 0x2563eb;

        const badgeHex = isConflict
          ? "#f87171"
          : isMoved
          ? "#34d399"
          : isDelayed
          ? "#fbbf24"
          : "#38bdf8";

        const trainRoot = new THREE.Group();
        trainRoot.userData = { trainId: a.train_id };

        const leadPos = curve.getPointAt(Math.min(0.96, Math.max(0.04, u)));
        const leadTan = curve.getTangentAt(Math.min(0.96, Math.max(0.04, u)));
        const yaw = Math.atan2(leadTan.z, leadTan.x);

        trainRoot.position.set(leadPos.x, 0.35, leadPos.z);
        trainRoot.rotation.y = -yaw;

        const carMat = new THREE.MeshStandardMaterial({
          color: bodyColor,
          metalness: 0.45,
          roughness: 0.3,
          emissive: isSelected ? bodyColor : 0x000000,
          emissiveIntensity: isSelected ? 0.38 : 0,
        });
        const roofMat = new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          metalness: 0.3,
          roughness: 0.5,
        });
        const winMat = new THREE.MeshBasicMaterial({ color: 0xbae6fd });

        [2.2, -2.4].forEach((carX, carIdx) => {
          const carBody = new THREE.Mesh(
            new THREE.BoxGeometry(4.1, 1.35, 1.55),
            carMat
          );
          carBody.position.set(carX, 0.85, 0);
          carBody.castShadow = true;
          carBody.userData = { trainId: a.train_id };
          trainRoot.add(carBody);

          const carRoof = new THREE.Mesh(
            new THREE.BoxGeometry(3.9, 0.18, 1.35),
            roofMat
          );
          carRoof.position.set(carX, 1.6, 0);
          carRoof.userData = { trainId: a.train_id };
          trainRoot.add(carRoof);

          const winStrip = new THREE.Mesh(
            new THREE.BoxGeometry(3.4, 0.38, 1.62),
            winMat
          );
          winStrip.position.set(carX, 1.0, 0);
          winStrip.userData = { trainId: a.train_id };
          trainRoot.add(winStrip);

          if (carIdx === 0) {
            const nose = new THREE.Mesh(
              new THREE.ConeGeometry(0.78, 1.2, 4),
              carMat
            );
            nose.rotation.z = -Math.PI / 2;
            nose.rotation.y = Math.PI / 4;
            nose.position.set(carX + 2.55, 0.75, 0);
            nose.userData = { trainId: a.train_id };
            trainRoot.add(nose);

            [-0.42, 0.42].forEach((hz) => {
              const headlight = new THREE.Mesh(
                new THREE.SphereGeometry(0.14, 8, 8),
                new THREE.MeshBasicMaterial({ color: 0xfef08a })
              );
              headlight.position.set(carX + 2.9, 0.65, hz);
              trainRoot.add(headlight);
            });
          }
        });

        const titleText = isMoved
          ? `${a.train_id} (${chg?.previous_platform}→${a.platform_id})`
          : `${a.train_id} · ${a.platform_id}`;
        const subText = `${stateLabel}${
          a.total_delay_minutes > 0 ? ` · +${a.total_delay_minutes}m` : " · ON TIME"
        }`;
        const labelTex = createBadgeTexture(
          titleText,
          subText,
          badgeHex,
          isSelected ? "rgba(14, 116, 144, 0.96)" : "rgba(8, 17, 34, 0.92)"
        );
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: labelTex, depthTest: false })
        );
        sprite.position.set(0, 3.35, 0);
        sprite.scale.set(5.6, 2.0, 1);
        sprite.userData = { trainId: a.train_id };
        trainRoot.add(sprite);

        trainsGroup.add(trainRoot);
      });
    };

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      syncDynamicObjects();

      const { radius, theta, phi, target } = camSpherical.current;
      const sinPhi = Math.sin(phi);
      camera.position.set(
        target.x + radius * sinPhi * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * sinPhi * Math.cos(theta)
      );
      camera.lookAt(target);

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      resizeObs.disconnect();
      domEl.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      domEl.removeEventListener("wheel", onWheel);
      domEl.removeEventListener("contextmenu", onContextMenu);
      domEl.removeEventListener("webglcontextlost", handleContextLost);
      renderer.dispose();
    };
  }, []);

  if (!webglReady) {
    return null;
  }

  return (
    <div
      className="three-station-geo-wrapper"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "420px",
        background:
          localGeoStyle === "satellite"
            ? "radial-gradient(circle at center, #0f291e 0%, #05101a 100%)"
            : "radial-gradient(circle at center, #dbeafe 0%, #94a3b8 100%)",
        overflow: "hidden",
      }}
    >
      {/* Floating 3D Real Geospatial Map Layer Switcher */}
      <div
        className="three-geo-hud-bar"
        data-testid="three-geo-hud-bar"
        style={{
          position: "absolute",
          top: "12px",
          left: "12px",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "5px 10px",
          background: "rgba(15, 23, 42, 0.9)",
          border: "1px solid rgba(59, 130, 246, 0.5)",
          borderRadius: "8px",
          color: "#f8fafc",
          fontSize: "11px",
          fontWeight: 700,
        }}
      >
        <span style={{ color: "#60a5fa" }}>🌍 3D REAL GEO MAP BASE:</span>
        <button
          type="button"
          onClick={() => setLocalGeoStyle("osm")}
          data-testid="three-geo-street-btn"
          style={{
            padding: "3px 8px",
            borderRadius: "5px",
            border: "1px solid #3b82f6",
            background: localGeoStyle === "osm" ? "#2563eb" : "transparent",
            color: "#ffffff",
            fontSize: "10.5px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Real Street Map 3D
        </button>
        <button
          type="button"
          onClick={() => setLocalGeoStyle("satellite")}
          data-testid="three-geo-sat-btn"
          style={{
            padding: "3px 8px",
            borderRadius: "5px",
            border: "1px solid #3b82f6",
            background:
              localGeoStyle === "satellite" ? "#2563eb" : "transparent",
            color: "#ffffff",
            fontSize: "10.5px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Real Satellite 3D
        </button>
        <span
          style={{
            marginLeft: "6px",
            color: "#34d399",
            fontFamily: "monospace",
          }}
        >
          ● Live 3D Routes &amp; Switches Active
        </span>
      </div>

      <div
        ref={containerRef}
        className="three-station-viewport"
        data-testid="three-station-container"
        style={{ width: "100%", height: "100%", minHeight: "420px" }}
      />
    </div>
  );
};
