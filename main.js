import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// plan space (mm, x right, y down on the drawing, z up)  ->  three (m, Y up)
const P = (x, y, z = 0) => new THREE.Vector3(x / 1000, z / 1000, y / 1000);
const EYE = 1.6;
const qs = new URLSearchParams(location.search);
const SHOT = qs.has("shot");
if (SHOT) document.body.classList.add("shot");

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: SHOT });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.32;   // matches Blender exposure +0.4
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa89f93);   // wall-toned: hides hairline cracks at wall/ceiling joins (windows show their own backdrop)
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.03, 60);
camera.rotation.order = "YXZ";

const manager = new THREE.LoadingManager();
const bar = document.querySelector("#loader i");
manager.onProgress = (_, a, b) => (bar.style.width = `${(100 * a) / b}%`);

const [plan, views, lmMeta, doorMeta] = await Promise.all(
  ["assets/plan.json", "assets/views.json", "assets/lightmaps.json", "assets/doors.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : {}))));
// movable cabinet parts (doors, drawers, flaps): node name -> { lm, kind: rot|slide, axis, angle | slide }
const partOf = (o) => { for (let p = o; p; p = p.parent) if (doorMeta[p.name]) return p.name; return null; };

// ------------------------------------------------------------------ model
const texLoader = new THREE.TextureLoader(manager);
const lightmaps = {};
const [gltf] = await Promise.all([
  new GLTFLoader(manager).loadAsync("assets/flat.glb"),
  ...Object.entries(lmMeta).map(async ([g, m]) => {
    const t = await texLoader.loadAsync(`assets/lm_${g}.jpg`);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.channel = 1;
    // no mip-maps: averaged texels bleed light across UV-island seams (bright lines at wall/ceiling joins)
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    lightmaps[g] = { tex: t, intensity: Math.PI * m.scale };
  }),
]);
const floors = [];
const mirrors = [];
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  const g = (o.parent && lightmaps[o.parent.name] ? o.parent.name : o.name).replace(/_\d+$/, "");
  const pn = partOf(o);
  const lm = pn ? lightmaps[doorMeta[pn].lm] : lightmaps[g] || lightmaps[o.name];
  const src = o.material;
  const name = src.name || "";
  if (name === "glass") {   // only the window / shower panes; vases and holders stay as baked
    o.material = new THREE.MeshPhysicalMaterial({ color: 0xe8f0f0, transparent: true, opacity: 0.1, roughness: 0, depthWrite: false });
    o.renderOrder = 2;
    return;
  }
  const m = src.clone();
  if (lm) { m.lightMap = lm.tex; m.lightMapIntensity = lm.intensity; }
  m.envMapIntensity = 0;
  // light is baked into diffuse only: metals would turn black, so render them as their tinted diffuse colour
  if (m.metalness > 0 && !/mirror/.test(name)) { m.metalness = 0; m.roughness = Math.max(m.roughness, 0.4); }
  if (/mirror/.test(name)) mirrors.push(o);
  o.material = m;
  if (/_floor$/.test(g) || /floor/.test(o.name)) floors.push(o);
});
scene.add(gltf.scene);
window.__scene = scene;

// ------------------------------------------------------------------ cabinets: click a front to open / close it
const parts = {};
for (const [name, meta] of Object.entries(doorMeta)) {
  const node = gltf.scene.getObjectByName(name);
  if (!node) continue;
  const meshes = [];
  node.traverse((o) => o.isMesh && meshes.push(o));
  parts[name] = {
    node, meta, meshes, t: 0, goal: 0, pos0: node.position.clone(), q0: node.quaternion.clone(),
    axis: meta.axis && new THREE.Vector3(...meta.axis), slide: meta.slide && new THREE.Vector3(...meta.slide),
  };
}
const partList = Object.values(parts);
window.__parts = parts; window.__cam = camera;
const partMeshes = partList.flatMap((p) => p.meshes);
const occluders = [];
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  const n = (o.parent && o.parent.name) || o.name;
  if (/^(living_walls|bedroom_walls|bath_shell|doors)/.test(n) || /^(living_walls|bedroom_walls|bath_shell|doors)/.test(o.name)) occluders.push(o);
});
const _q = new THREE.Quaternion();
function applyPart(p) {
  const s = p.t * p.t * (3 - 2 * p.t);
  if (p.meta.kind === "rot") p.node.quaternion.copy(_q.setFromAxisAngle(p.axis, p.meta.angle * s)).multiply(p.q0);
  else p.node.position.copy(p.pos0).addScaledVector(p.slide, s);
}
// fronts that would hit each other (kitchen corner: waste pull-out vs. dishwasher door / corner pull-out) list each
// other in `conflicts`: opening one closes the others; "open all" skips parts marked all: false
// inner drawers (`requires`) only move while their outer front is open: closing the front closes them too
function toggle(p) {
  p.goal = p.goal ? 0 : 1;
  if (p.goal) {
    for (const n of p.meta.conflicts || []) if (parts[n]) parts[n].goal = 0;
    if (p.meta.requires && parts[p.meta.requires]) parts[p.meta.requires].goal = 1;
  } else for (const q of partList) if (q.meta.requires === p.node.name) q.goal = 0;
  updateCabBtn();
}
const inAll = (p) => p.meta.all !== false;
function setAll(open, instant = false) {
  for (const p of partList) { p.goal = open && inAll(p) ? 1 : 0; if (instant) { p.t = p.goal; applyPart(p); } }
  updateCabBtn();
}
let hover = null;
function highlight(p) {
  if (hover === p) return;
  if (hover) for (const m of hover.meshes) m.material.emissive.setHex(0x000000);
  hover = p;
  if (p) for (const m of p.meshes) m.material.emissive.setHex(0x2b2116);
  el_cursor(p ? "pointer" : "");
}
function pickPart(ndc) {
  const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, camera);
  const hit = rc.intersectObjects(partMeshes, false)[0];
  if (!hit) return null;
  const wall = rc.intersectObjects(occluders, false)[0];
  if (wall && wall.distance < hit.distance - 0.02) return null;
  return parts[partOf(hit.object)] || null;
}

// unlit ceiling-coloured cap 5 mm above the ceiling: hairline cracks at wall/ceiling joins show this instead of the neighbouring room
const cap = new THREE.Mesh(new THREE.PlaneGeometry(9, 8), new THREE.MeshBasicMaterial({ color: 0x9c9388, side: THREE.DoubleSide }));
cap.rotation.x = Math.PI / 2; cap.position.copy(P(3800, 3500, 2750)); scene.add(cap);
// park behind the windows
const backTex = await texLoader.loadAsync("assets/backdrop.jpg");
backTex.colorSpace = THREE.SRGBColorSpace;
const back = new THREE.Mesh(new THREE.PlaneGeometry(26, 9), new THREE.MeshBasicMaterial({ map: backTex }));
back.position.copy(P(3800, -5200, 1600)); scene.add(back);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 8), new THREE.MeshBasicMaterial({ color: 0x5d6d45 }));
ground.rotation.x = -Math.PI / 2; ground.position.copy(P(3800, -2000, -2900)); scene.add(ground);

// mirrors: one static cube reflection rendered after load
function setupMirrors() {
  for (const o of mirrors) {
    o.geometry = o.geometry.toNonIndexed(); o.geometry.computeVertexNormals();   // glTF is exported without normals (lightmapped); reflections need them
    const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType });
    const cc = new THREE.CubeCamera(0.05, 30, rt);
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox, c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    o.localToWorld(c);
    // step 30 cm off the wall along the mirror's thin axis, towards the walkable side
    const axis = size.x < size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const tryP = (s) => c.clone().addScaledVector(axis, 0.3 * s);
    // the reflecting side is the one from which a ray back to the centre hits the mirror first
    const sees = (p) => {
      const hit = new THREE.Raycaster(p, c.clone().sub(p).normalize(), 0, 0.5).intersectObjects(scene.children, true)[0];
      return hit && hit.object === o;
    };
    const a = tryP(1), b = tryP(-1);
    cc.position.copy(sees(a) ? a : b);
    o.visible = false; cc.update(renderer, scene); o.visible = true;
    o.material = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, metalness: 1, roughness: 0.04, envMap: rt.texture });
  }
}

// ------------------------------------------------------------------ walkable area = union of room outlines
const polys = plan.rooms.map((r) => r.polygon);
const inPoly = (p, x, y) => {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
};
const walkable = (x, y, r = 230) =>
  [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].every(([dx, dy]) => polys.some((p) => inPoly(p, x + dx, y + dy)));

// ------------------------------------------------------------------ controls
let yaw = 0, pitch = 0, fly = null;
function setView(v, animate = true) {
  const pos = P(...v.pos), tgt = P(...v.target);
  const d = tgt.clone().sub(pos);
  const toYaw = Math.atan2(-d.x, -d.z), toPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  if (!animate) { camera.position.copy(pos); yaw = toYaw; pitch = toPitch; return; }
  fly = { from: camera.position.clone(), to: pos, y0: yaw, y1: yaw + angleDelta(yaw, toYaw), p0: pitch, p1: toPitch, t: 0 };
}
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function walkTo(x, y) {
  const to = P(x, y, EYE * 1000);
  fly = { from: camera.position.clone(), to, y0: yaw, y1: yaw, p0: pitch, p1: Math.max(-0.25, Math.min(0.1, pitch)), t: 0 };
}

const el = renderer.domElement;
const el_cursor = (c) => (el.style.cursor = c);
let drag = null, hoverAt = null;
el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; el.setPointerCapture(e.pointerId); });
el.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") hoverAt = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX; drag.y = e.clientY;
  const k = (camera.fov * Math.PI) / 180 / innerHeight;
  yaw += dx * k; pitch = Math.max(-1.3, Math.min(1.3, pitch + dy * k)); fly = null;
});
el.addEventListener("pointerup", (e) => {
  if (drag && drag.moved < 6) {
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, camera);
    const hit = rc.intersectObjects(scene.children, true)[0];
    const pn = hit && partOf(hit.object);
    if (pn && parts[pn]) toggle(parts[pn]);
    else if (hit && hit.face && hit.face.normal.y > 0.7 && hit.point.y < 0.05) {
      const x = hit.point.x * 1000, y = hit.point.z * 1000;
      if (walkable(x, y)) walkTo(x, y);
    }
  }
  drag = null;
});
el.addEventListener("pointerleave", () => { hoverAt = null; highlight(null); });
el.addEventListener("wheel", (e) => { camera.fov = Math.max(35, Math.min(90, camera.fov + e.deltaY * 0.03)); camera.updateProjectionMatrix(); }, { passive: true });
const keys = new Set();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));

// ------------------------------------------------------------------ UI
const ROOMS = [
  ["living_new", "Гостиная"], ["living_desk", "Рабочее место"], ["living_storage", "Обеденная зона"], ["living_tv", "ТВ-зона"],
  ["kitchen", "Кухня"], ["hall", "Прихожая"], ["bedroom", "Спальня"], ["bath", "Ванная"],
];
const roomsEl = document.getElementById("rooms");
const buttons = {};
for (const [id, label] of ROOMS) {
  const b = document.createElement("button"); b.textContent = label;
  b.onclick = () => { setView(views[id]); for (const x of Object.values(buttons)) x.classList.remove("on"); b.classList.add("on"); };
  roomsEl.appendChild(b); buttons[id] = b;
}
const cabBtn = document.createElement("button");
cabBtn.className = "cab";
cabBtn.onclick = () => setAll(partList.some((p) => inAll(p) && p.goal === 0));
function updateCabBtn() { cabBtn.textContent = partList.some((p) => inAll(p) && p.goal === 0) ? "Открыть шкафы" : "Закрыть шкафы"; }
if (partList.length) { roomsEl.appendChild(cabBtn); updateCabBtn(); }
// mini-map
const NS = "http://www.w3.org/2000/svg";
const svg = document.createElementNS(NS, "svg");
svg.setAttribute("viewBox", "-300 -340 8100 7340");
for (const w of plan.walls) {
  const [x0, y0, x1, y1] = w.rect, r = document.createElementNS(NS, "rect");
  Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: "#8f877c" }).forEach(([k, v]) => r.setAttribute(k, v));
  svg.appendChild(r);
}
for (const room of plan.rooms) {
  const p = document.createElementNS(NS, "polygon");
  p.setAttribute("points", room.polygon.map((q) => q.join(",")).join(" "));
  p.setAttribute("fill", "rgba(243,238,230,.10)"); svg.prepend(p);
}
const dot = document.createElementNS(NS, "g");
dot.innerHTML = `<path d="M0 0 L-420 -900 A980 980 0 0 1 420 -900 Z" fill="rgba(201,138,90,.35)"/><circle r="170" fill="#c98a5a" stroke="#1b1916" stroke-width="50"/>`;
svg.appendChild(dot);
svg.addEventListener("click", (e) => {
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  if (walkable(p.x, p.y, 150)) walkTo(p.x, p.y);
});
document.getElementById("map").appendChild(svg);

// ------------------------------------------------------------------ loop
const start = views[qs.get("view")] || views.living_new;
setView(start, false);
if (SHOT && start.hfov) {
  const a = innerWidth / innerHeight;
  camera.fov = (2 * Math.atan(Math.tan((start.hfov * Math.PI) / 360) / a) * 180) / Math.PI;
} else camera.fov = 70;
camera.updateProjectionMatrix();

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

if (qs.get("open") === "all") setAll(true, true);

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const p of partList) {
    if (p.t === p.goal) continue;
    p.t = p.goal > p.t ? Math.min(p.goal, p.t + dt / 0.7) : Math.max(p.goal, p.t - dt / 0.7);
    applyPart(p);
  }
  if (hoverAt && !drag) { highlight(pickPart(hoverAt)); hoverAt = null; }
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / 1.1);
    const s = fly.t * fly.t * (3 - 2 * fly.t);
    camera.position.lerpVectors(fly.from, fly.to, s);
    yaw = fly.y0 + (fly.y1 - fly.y0) * s; pitch = fly.p0 + (fly.p1 - fly.p0) * s;
    if (fly.t >= 1) fly = null;
  }
  const f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
  const sdir = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  const turn = (keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0);
  yaw += turn * dt * 1.6;
  if (f || sdir) {
    fly = null;
    const sp = 1.5 * dt;
    const dx = (-Math.sin(yaw) * f + Math.cos(yaw) * sdir) * sp, dz = (-Math.cos(yaw) * f - Math.sin(yaw) * sdir) * sp;
    const x = camera.position.x * 1000, y = camera.position.z * 1000;
    if (walkable(x + dx * 1000, y)) camera.position.x += dx;
    if (walkable(camera.position.x * 1000, y + dz * 1000)) camera.position.z += dz;
  }
  camera.rotation.set(pitch, yaw, 0);
  dot.setAttribute("transform", `translate(${camera.position.x * 1000} ${camera.position.z * 1000}) rotate(${(-yaw * 180) / Math.PI})`);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
setupMirrors();
tick();
const loader = document.getElementById("loader");
loader.style.opacity = 0; setTimeout(() => loader.remove(), 600);
requestAnimationFrame(() => requestAnimationFrame(() => (window.__ready = true)));
