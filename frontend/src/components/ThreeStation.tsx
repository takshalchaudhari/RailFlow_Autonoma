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
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 256, 96);
    ctx.fillStyle = bgHex;
    ctx.beginPath();
    ctx.roundRect(6, 6, 244, 84, 14);
    ctx.fill();

    ctx.lineWidth = 4;
    ctx.strokeStyle = accentHex;
    ctx.stroke();

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 30px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(title, 128, 44);

    ctx.fillStyle = accentHex;
    ctx.font = "600 20px JetBrains Mono, monospace";
    ctx.fillText(subtitle, 128, 74);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function buildPlatformCurve(zOffset: number): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(-46, 0.35, zOffset * 0.18),
    new THREE.Vector3(-28, 0.35, zOffset * 0.25),
    new THREE.Vector3(-19, 0.35, zOffset),
    new THREE.Vector3(0, 0.35, zOffset),
    new THREE.Vector3(19, 0.35, zOffset),
    new THREE.Vector3(28, 0.35, zOffset * 0.25),
    new THREE.Vector3(46, 0.35, zOffset * 0.18),
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
  fitTrigger,
  zoomDeltaTrigger,
  onWebGLFailure,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [webglReady, setWebglReady] = useState<boolean>(true);

  // Spherical camera state for smooth Orbit + Pan + Zoom
  const camSpherical = useRef({
    radius: 56,
    theta: 0.38,
    phi: 0.92,
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
      camSpherical.current.phi = 0.92;
      camSpherical.current.theta = 0.36;
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
      camSpherical.current.phi = 0.92;
      camSpherical.current.theta = 0.36;
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
        alpha: false,
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
    renderer.setClearColor(0x060d1a, 1);

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
    scene.fog = new THREE.FogExp2(0x060d1a, 0.0065);

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.5, 300);

    // Lighting
    const ambient = new THREE.AmbientLight(0x9ec5fe, 1.15);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.9);
    hemi.position.set(0, 50, 0);
    scene.add(hemi);

    const dirLight = new THREE.DirectionalLight(0xf8fafc, 1.55);
    dirLight.position.set(28, 46, 24);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 5;
    dirLight.shadow.camera.far = 130;
    const d = 48;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    scene.add(dirLight);

    // Ground & Tactical Grid
    const groundGeo = new THREE.PlaneGeometry(160, 90);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x081223,
      roughness: 0.92,
      metalness: 0.08,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(150, 50, 0x1e3a5f, 0x0f223d);
    grid.position.y = 0.02;
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

    // Build static Tracks, Sleepers, Catenary Portals & Platforms
    const currentPlatforms = latestProps.current.platforms;
    const platformCurves = new Map<string, THREE.CatmullRomCurve3>();
    const platformSignalLights = new Map<string, THREE.Mesh>();

    const railMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.78,
      roughness: 0.28,
    });
    const sleeperMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.85,
    });
    const ballastMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.95,
    });

    currentPlatforms.forEach((plat, idx) => {
      const zOffset = (idx - (currentPlatforms.length - 1) / 2) * 9.5;
      const curve = buildPlatformCurve(zOffset);
      platformCurves.set(plat.id, curve);

      // Ballast bed along curve
      const points = curve.getSpacedPoints(70);
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const tangent = curve.getTangent(i / (points.length - 1));
        const angle = Math.atan2(tangent.z, tangent.x);

        // Sleeper
        const sleeper = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 0.12, 2.1),
          sleeperMat
        );
        sleeper.position.set(pt.x, 0.08, pt.z);
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
            .setY(0.22);
        });
        const railCurve = new THREE.CatmullRomCurve3(offsetPts);
        const railGeo = new THREE.TubeGeometry(railCurve, 64, 0.07, 6, false);
        const railMesh = new THREE.Mesh(railGeo, railMat);
        tracksGroup.add(railMesh);
      });

      // Ballast strip under platform track
      const ballast = new THREE.Mesh(
        new THREE.BoxGeometry(42, 0.1, 2.8),
        ballastMat
      );
      ballast.position.set(0, 0.05, zOffset);
      tracksGroup.add(ballast);

      // Platform Deck ( positioned immediately North of the track at zOffset - 2.9 )
      const platZ = zOffset - 2.95;
      const platGroup = new THREE.Group();
      platGroup.userData = { platformId: plat.id };

      const deckMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.65,
        metalness: 0.15,
      });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(36, 0.9, 3.1), deckMat);
      deck.position.set(0, 0.45, platZ);
      deck.castShadow = true;
      deck.receiveShadow = true;
      deck.userData = { platformId: plat.id };
      platGroup.add(deck);

      // Yellow safety tactile edge strip
      const safetyStrip = new THREE.Mesh(
        new THREE.BoxGeometry(36, 0.06, 0.22),
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
        opacity: 0.88,
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

      // Platform Sign Sprite (P1, P2, P3)
      const signTex = createBadgeTexture(
        plat.id,
        `GAP ${plat.clearance_minutes ?? plat.min_gap_minutes ?? 10}M`,
        "#38bdf8"
      );
      const signSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: signTex, depthTest: false })
      );
      signSprite.position.set(-15.5, 4.9, platZ);
      signSprite.scale.set(4.5, 1.7, 1);
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
        new THREE.SphereGeometry(0.18, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x10b981 })
      );
      sigLamp.position.set(19.45, 2.65, zOffset - 1.35);
      buildingsGroup.add(sigLamp);
      platformSignalLights.set(plat.id, sigLamp);

      platformsGroup.add(platGroup);
    });

    // Siding Track on South Side
    const sidingZ = 16.5;
    const sidingBallast = new THREE.Mesh(
      new THREE.BoxGeometry(30, 0.1, 2.4),
      ballastMat
    );
    sidingBallast.position.set(-12, 0.05, sidingZ);
    tracksGroup.add(sidingBallast);

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
        opacity: 0.32,
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
        opacity: 0.5,
      })
    );
    towerGlass.position.set(12, 8.1, -20.5);
    stationBuilding.add(towerGlass);

    // South-West Maintenance Depot
    const depot = new THREE.Mesh(
      new THREE.BoxGeometry(14, 3.8, 5.5),
      new THREE.MeshStandardMaterial({
        color: 0x17253b,
        roughness: 0.7,
      })
    );
    depot.position.set(-20, 1.9, 21.5);
    depot.castShadow = true;
    stationBuilding.add(depot);

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
      if (movedDist > 6) return; // Dragged, not clicked

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);

      // 1. Check raycast intersections on trains first, then platforms
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

      // 2. Proximity screen-space fallback for trains (makes small train meshes easy to click)
      let closestTrainId: string | null = null;
      let closestTrainDist = 38; // pixel threshold
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

      // 3. Check raycast intersections on platforms
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

    // Dynamic state synchronization helper (runs each frame cleanly)
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

      // Clear previous dynamic meshes
      const clearGroup = (grp: THREE.Group) => {
        while (grp.children.length > 0) {
          const child = grp.children[0];
          grp.remove(child);
        }
      };
      clearGroup(closuresGroup);
      clearGroup(routesGroup);
      clearGroup(trainsGroup);

      // Update Platform Closures & Signals
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

        const sigLamp = platformSignalLights.get(plat.id);
        if (sigLamp) {
          const mat = sigLamp.material as THREE.MeshBasicMaterial;
          if (pClosures.length > 0 || hasConflictOnPlat) {
            mat.color.setHex(0xef4444);
          } else {
            mat.color.setHex(0x10b981);
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

          // Red hazard volume over track and platform
          const hazardBox = new THREE.Mesh(
            new THREE.BoxGeometry(36, 1.5, 4.2),
            new THREE.MeshBasicMaterial({
              color: 0xef4444,
              transparent: true,
              opacity: isClosedNow ? 0.34 : 0.18,
            })
          );
          hazardBox.position.set(0, 0.85, zOffset - 1.1);
          hazardGroup.add(hazardBox);

          // Red/white physical barrier blocks at West & East ends of track
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

      // Build Trains & Selected Route Highlight
      const conflictingTrains = new Set<string>();
      valErrs.forEach((err) => {
        (err.train_ids ?? []).forEach((t) => conflictingTrains.add(t));
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

        // Calculate normalized parameter u in [0.04, 0.96] along track spline from simClock
        let u = 0.5;
        let stateLabel = "DWELLING";
        if (clock < a.arrival - 20) {
          u = 0.06;
          stateLabel = `SCHED ${a.arrival_str}`;
        } else if (clock < a.arrival) {
          const ratio = 1 - (a.arrival - clock) / 20;
          u = 0.06 + ratio * 0.36;
          stateLabel = "APPROACHING";
        } else if (clock >= a.arrival && clock < a.departure) {
          const ratio =
            (clock - a.arrival) / Math.max(1, a.departure - a.arrival);
          u = 0.42 + ratio * 0.16;
          stateLabel = "DWELLING";
        } else if (clock >= a.departure && clock < a.departure + 20) {
          const ratio = (clock - a.departure) / 20;
          u = 0.58 + ratio * 0.36;
          stateLabel = "DEPARTING";
        } else {
          u = 0.95;
          stateLabel = "CLEARED";
        }

        const chg = chgs.find((c) => c.train_id === a.train_id);
        const isConflict = conflictingTrains.has(a.train_id);
        const isDelayed = a.total_delay_minutes > 0;
        const isMoved = Boolean(chg?.platform_changed);
        const isSelected = selTid === a.train_id;

        const bodyColor = isConflict
          ? 0xdc2626
          : isDelayed
          ? 0xd97706
          : isMoved
          ? 0x10b981
          : a.fixed || a.departed
          ? 0x6366f1
          : 0x0ea5e9;

        const badgeHex = isConflict
          ? "#f87171"
          : isDelayed
          ? "#fbbf24"
          : isMoved
          ? "#34d399"
          : "#38bdf8";

        // Highlight active route if selected or moved
        if (isSelected || isMoved) {
          const routeGeo = new THREE.TubeGeometry(
            curve,
            64,
            isSelected ? 0.22 : 0.14,
            8,
            false
          );
          const routeMat = new THREE.MeshBasicMaterial({
            color: isConflict ? 0xef4444 : isMoved ? 0x10b981 : 0x38bdf8,
            transparent: true,
            opacity: isSelected ? 0.75 : 0.4,
          });
          routesGroup.add(new THREE.Mesh(routeGeo, routeMat));

          // If reassigned, also show subtle ghost line on original platform
          if (
            isMoved &&
            chg?.previous_platform &&
            platformCurves.has(chg.previous_platform)
          ) {
            const oldCurve = platformCurves.get(chg.previous_platform)!;
            const ghostGeo = new THREE.TubeGeometry(
              oldCurve,
              48,
              0.1,
              6,
              false
            );
            const ghostMat = new THREE.MeshBasicMaterial({
              color: 0x94a3b8,
              transparent: true,
              opacity: 0.28,
            });
            routesGroup.add(new THREE.Mesh(ghostGeo, ghostMat));
          }
        }

        // Build 2-car articulated train mesh along the curve
        const trainRoot = new THREE.Group();
        trainRoot.userData = { trainId: a.train_id };

        const leadPos = curve.getPointAt(Math.min(0.98, Math.max(0.02, u)));
        const leadTan = curve.getTangentAt(Math.min(0.98, Math.max(0.02, u)));
        const yaw = Math.atan2(leadTan.z, leadTan.x);

        trainRoot.position.set(leadPos.x, 0.35, leadPos.z);
        trainRoot.rotation.y = -yaw;

        const carMat = new THREE.MeshStandardMaterial({
          color: bodyColor,
          metalness: 0.45,
          roughness: 0.3,
          emissive: isSelected ? bodyColor : 0x000000,
          emissiveIntensity: isSelected ? 0.35 : 0,
        });
        const roofMat = new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          metalness: 0.3,
          roughness: 0.5,
        });
        const winMat = new THREE.MeshBasicMaterial({ color: 0xbae6fd });

        // Lead Power Car + Trailing Coach
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

          // Illuminated window strip on both sides
          const winStrip = new THREE.Mesh(
            new THREE.BoxGeometry(3.4, 0.38, 1.62),
            winMat
          );
          winStrip.position.set(carX, 1.0, 0);
          winStrip.userData = { trainId: a.train_id };
          trainRoot.add(winStrip);

          if (carIdx === 0) {
            // Aerodynamic nose cone + dual headlights
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

        // Floating Telemetry Label Sprite above train
        const subText = `${a.platform_id} · ${stateLabel}${
          a.total_delay_minutes > 0 ? ` +${a.total_delay_minutes}m` : ""
        }`;
        const labelTex = createBadgeTexture(
          a.train_id,
          subText,
          badgeHex,
          isSelected ? "rgba(14, 116, 144, 0.96)" : "rgba(8, 17, 34, 0.92)"
        );
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: labelTex, depthTest: false })
        );
        sprite.position.set(0, 3.25, 0);
        sprite.scale.set(5.4, 2.0, 1);
        sprite.userData = { trainId: a.train_id };
        trainRoot.add(sprite);

        trainsGroup.add(trainRoot);
      });
    };

    // Main Render Loop
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
      ref={containerRef}
      className="three-station-viewport"
      data-testid="three-station-container"
    />
  );
};
