import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { LineMaterial } from "../vendor/lines/LineMaterial.js";
import { LineSegments2 } from "../vendor/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "../vendor/lines/LineSegmentsGeometry.js";

// Interactive Console：几个房间在门口对接成一套房子的点云，随世界时间变化；时间轴上每条线是一个相机角度
// （第 0 条是原片，其余是在点云里换机位渲染、再用 V2V 补成画面的新角度），同一竖直位置是同一世界时刻。
// 数据由 figure_build/console_build/build_console.py 生成，current.json 指向当前展示的世界
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.7v14.6a1 1 0 0 0 1.52.85l11.8-7.3a1 1 0 0 0 0-1.7L8.52 3.85A1 1 0 0 0 7 4.7z"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4.5" width="4.6" height="15" rx="1.2"/><rect x="13.9" y="4.5" width="4.6" height="15" rx="1.2"/></svg>';
// 同时留在显存里的动态点云段数，超过就释放最久没用的
const DYN_KEEP = 6;
// 同时持有视频数据的播放器个数
const VIDEO_KEEP = 12;
// 非主视频与世界时间相差超过这个秒数就重新对位
const DRIFT = 0.3;
// 取景时房间包围盒的高度（地面到 2.2 m）
const FRAME_TOP = 2.2;
// 自由视角的视场角
const FREE_FOV = 45;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (x) => x * x * (3 - 2 * x);

// 镜头编号写成给人看的样子：shot_06 写成 Shot 6
function shotLabel(shot) {
  const n = Number(shot.replace(/^shot_/, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`镜头编号 ${shot} 不是 shot_NN 的形式`);
  return `Shot ${n}`;
}

function clock(seconds, digits = 1) {
  if (digits === 0) {
    const whole = Math.floor(Math.max(0, seconds) + 1e-6);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  const tenths = Math.floor(Math.max(0, seconds) * 10 + 1e-6);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

// 数据每次重新构建都可能变：一律先向服务器确认，浏览器里旧的缓存只在没变时才用
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchBuffer(url, onProgress) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("Content-Length"));
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (onProgress) onProgress(loaded, Number.isFinite(total) && total > 0 ? total : null);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

// 点到线段的屏幕距离，用来判断点击是否落在轨迹上
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const u = len > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

// 点：出现时刻由画多少个点控制（点按出现时刻排序）；之后会被移出的点带 aT1（百分之一秒），到时刻就不画
const POINT_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  #ifdef USE_T1
  attribute float aT1;
  #endif
  uniform float uTime;
  uniform float uSize;
  uniform float uScale;
  uniform float uCut;
  uniform float uMinPx;
  uniform float uMaxPx;
  varying vec3 vColor;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    bool hide = world.y > uCut;
    #ifdef USE_T1
    hide = hide || uTime >= aT1 * 0.01;
    #endif
    if (hide) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * uScale / max(-mv.z, 1e-3), uMinPx, uMaxPx);
    vColor = aColor;
  }
`;

const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

class WorldConsole {
  constructor(root) {
    const $ = (selector) => {
      const node = root.querySelector(selector);
      if (!node) throw new Error(`Interactive Console 缺少 ${selector}`);
      return node;
    };
    this.root = root;
    this.el = {
      meta: $(".console-meta"),
      chips: $(".console-chips"),
      stage: $(".console-stage"),
      film: $(".console-film"),
      lead: $(".console-lead"),
      thumbs: $(".console-thumbs"),
      world: $(".console-world"),
      viewer: $(".console-viewer"),
      canvas: $(".console-canvas"),
      pick: $(".console-pick-label"),
      loading: $(".console-loading"),
      loadingText: $(".console-loading span"),
      loadingBar: $(".console-loading b"),
      arrows: $(".console-arrows"),
      play: $(".console-play"),
      time: $(".console-clock time"),
      total: $(".console-clock span"),
      laneLabels: $(".console-lane-labels"),
      track: $(".console-track"),
      playhead: $(".console-playhead"),
      ticks: $(".console-ticks"),
    };
    this.reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.state = {
      t: 0,
      playing: !this.reduce,
      lane: 0,
      scrubbing: false,
      visible: false,
      hover: null,
      preset: "house",
    };
    this.tiles = new Map();
    this.arrows = new Map();
    this.dyns = new Map();
    this.pointMaterials = [];
    this.groups = [];
    this.view = { active: [], rooms: new Set(), shots: [], master: null, lead: null, tiles: [] };
    this.raf = 0;
    this.lastNow = 0;
    this.dirty = true;
    this.needSeek = true;
    this.drag = null;
    this.press = null;
    this.anim = null;
    this.userMoved = 0;
    this.ready = false;
    this.progress = null;
    this.uiKey = "";
    this.filmKey = "";
    this.loop = this.loop.bind(this);
  }

  async start() {
    const base = new URL("./", import.meta.url);
    const current = await fetchJSON(new URL("current.json", base));
    this.worldUrl = new URL(current.world, base);
    const world = await fetchJSON(this.worldUrl);
    if (world.version !== 4) throw new Error(`world.json 版本 ${world.version}，这一版控制台读第 4 版（多角度、相机断开的镜头）`);
    this.world = world;
    this.rooms = new Map(world.rooms.map((room) => [room.id, room]));
    this.lanes = world.lanes;
    this.segments = new Map();
    world.segments.forEach((seg) => {
      if (!this.rooms.has(seg.scene)) throw new Error(`${seg.id} 的房间 ${seg.scene} 不在 rooms 里`);
      if (!this.lanes[seg.lane]) throw new Error(`${seg.id} 的线 ${seg.lane} 不在 lanes 里`);
      if (seg.cameras.frames < 2) throw new Error(`${seg.id} 只有 ${seg.cameras.frames} 帧相机`);
      seg.duration = seg.world_end - seg.world_start;
      // 相机断开的镜头：camera_spans 是有相机的半开帧区间，区间外的帧不画相机、视锥、箭头和动态点
      seg.camOk = null;
      if (seg.camera_spans) {
        seg.camOk = new Uint8Array(seg.cameras.frames);
        for (const [a, b] of seg.camera_spans) {
          if (!(b - a >= 2 && b <= seg.cameras.frames)) throw new Error(`${seg.id} 的相机区间 ${a}–${b} 不对`);
          seg.camOk.fill(1, a, b);
        }
      }
      this.segments.set(seg.id, seg);
    });
    this.intervals = world.intervals.map((iv) => ({ ...iv, segs: iv.segments.map((id) => this.segments.get(id)) }));
    // 镜头：原片线（第 0 条）上每一段就是 timeline.json 里的一个镜头，时间轴上每条线每个镜头画一根整条
    this.shots = world.segments
      .filter((seg) => seg.lane === 0)
      .map((seg) => ({ shot: seg.shot, scene: seg.scene, world_start: seg.world_start, world_end: seg.world_end, registered: seg.registered, fps: seg.fps }));
    this.shotMap = new Map(this.shots.map((shot) => [shot.shot, shot]));
    for (const seg of world.segments) {
      const shot = this.shotMap.get(seg.shot);
      if (!shot || seg.world_start < shot.world_start - 1e-3 || seg.world_end > shot.world_end + 1e-3) {
        throw new Error(`${seg.id} 不在原片线的镜头区间里`);
      }
    }
    // 小画面是这一刻有视频、但不在大画面里的角度：同一时刻最多的个数决定小画面区的高度
    this.thumbMax = Math.max(0, ...this.intervals.map((iv) => iv.segs.length - 1));
    this.buildHeader();
    this.buildFilm();
    this.buildTimeline();
    this.initThree();
    this.buildRooms3d();
    this.bindEvents();
    window.atasConsole = {
      state: () => this.snapshot(),
      renderNow: () => {
        this.update();
        this.render();
      },
      // 用页面当前的相机把一个房子坐标的点投到屏幕上（测试拿来与自己算的投影比对）
      project: (p) => {
        const at = this.toClient(new THREE.Vector3(p[0], p[1], p[2]), this.el.canvas.getBoundingClientRect());
        return at && [at.x, at.y];
      },
    };
    Promise.all([this.loadStatic(), ...world.segments.map((seg) => this.ensureCameras(seg))]).then(() => {
      this.ready = true;
      if (this.state.preset === "house") this.applyView(this.houseView());
      this.dirty = true;
    });
    this.update();
    if (!this.root.hidden) this.show();
  }

  url(file) {
    return new URL(file, this.worldUrl).href;
  }

  laneLabel(seg) {
    return this.lanes[seg.lane].label;
  }

  // 这一段拍的是哪个镜头、哪个房间、哪段世界时间
  whereFor(seg) {
    return `${shotLabel(seg.shot)} · ${this.rooms.get(seg.scene).label} · ${clock(seg.world_start, 0)}–${clock(seg.world_end, 0)}`;
  }

  // 大画面下的说明：新角度写实际的机位；没有写进世界的镜头注明一句
  noteFor(seg) {
    const parts = [];
    if (seg.design) parts.push(`${seg.design[0].toUpperCase()}${seg.design.slice(1)}.`);
    if (!seg.registered) parts.push("Not merged into the world.");
    return parts.join(" ");
  }

  // 这一段第 i 帧有没有相机
  camAt(seg, i) {
    return !seg.camOk || seg.camOk[i] === 1;
  }

  // 这个镜头在世界时刻 t 有没有动态点（相机断开的镜头只在有相机的区间里有）
  dynAt(dynamic, t) {
    return !dynamic.spans || dynamic.spans.some(([a, b]) => a <= t && t < b);
  }

  // 有相机的最长一段区间的中间那一帧
  midFrame(seg) {
    if (!seg.camera_spans) return Math.floor(seg.cameras.frames / 2);
    const [a, b] = seg.camera_spans.reduce((best, span) => (span[1] - span[0] > best[1] - best[0] ? span : best));
    return Math.floor((a + b) / 2);
  }

  // ---------- 页面结构 ----------

  buildHeader() {
    const w = this.world;
    this.el.meta.textContent = w.title;
    this.el.total.textContent = clock(w.duration, 0);
    const colors = this.lanes.map((lane) => lane.color);
    if (colors.length === 1) colors.push(colors[0]);
    this.el.world.style.setProperty("--lanes-bar", `linear-gradient(90deg, ${colors.join(", ")})`);
  }

  // 大画面的高度固定：放一个看不见的占位，结构与大画面相同，说明取这个世界里最长的一段；真正的大画面叠在它上面。
  // 这样换角度、换段、大画面空着时，视频栏和下面的时间轴都不跳
  buildFilm() {
    const longest = (texts) => texts.reduce((a, b) => (b.length > a.length ? b : a), "");
    const sizer = document.createElement("div");
    sizer.className = "console-lead-sizer";
    sizer.setAttribute("aria-hidden", "true");
    const box = document.createElement("span");
    box.className = "console-lead-sizer-video";
    const cap = document.createElement("span");
    cap.className = "console-tile-cap";
    const name = document.createElement("strong");
    name.textContent = longest(this.lanes.map((lane) => lane.label));
    const where = document.createElement("span");
    where.className = "console-tile-where";
    where.textContent = longest(this.world.segments.map((seg) => this.whereFor(seg)));
    const note = document.createElement("span");
    note.className = "console-tile-note";
    note.textContent = longest(this.world.segments.map((seg) => this.noteFor(seg)));
    cap.append(name, where, note);
    sizer.append(box, cap);
    this.leadSizer = sizer;
    // 小画面区的高度也固定：按同一时刻最多的小画面数排出的行数算最小高度，宽度变了重算
    this.el.thumbs.hidden = this.thumbMax === 0;
    new ResizeObserver(() => this.sizeThumbs()).observe(this.el.thumbs);
  }

  // 小画面区的最小高度：一个小画面高 = 边框 + 16:9 的视频 + 一行说明；行数 = 最多的小画面数 / 每行能放几个
  sizeThumbs() {
    const box = this.el.thumbs;
    if (box.hidden) return;
    const style = getComputedStyle(box);
    const tracks = style.gridTemplateColumns.split(" ").map(parseFloat).filter((v) => v > 0);
    if (!tracks.length) return;
    const rows = Math.ceil(this.thumbMax / tracks.length);
    const gap = parseFloat(style.rowGap);
    const tile = 2 + ((tracks[0] - 2) * 9) / 16 + parseFloat(style.getPropertyValue("--thumb-cap"));
    const height = `${(rows * tile + (rows - 1) * gap).toFixed(2)}px`;
    if (box.style.minHeight !== height) box.style.minHeight = height;
  }

  buildTimeline() {
    const w = this.world;
    const track = this.el.track;
    const lanes = this.lanes.length;
    const laneHeight = lanes <= 4 ? 34 : 28;
    for (const node of [track, this.el.laneLabels]) {
      node.style.setProperty("--lanes", lanes);
      node.style.setProperty("--lane-h", `${laneHeight}px`);
    }
    this.laneButtons = this.lanes.map((lane) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.lane = String(lane.lane);
      button.style.setProperty("--c", lane.color);
      button.setAttribute("aria-pressed", String(lane.lane === this.state.lane));
      const dot = document.createElement("i");
      button.append(dot, lane.label);
      return button;
    });
    this.el.laneLabels.replaceChildren(...this.laneButtons);
    // 每条线、每个镜头一根整条，盖住这个镜头的整个世界区间；一个镜头在一条线上分成几段时也只画一根
    this.bars = new Map();
    for (const lane of this.lanes) {
      for (const shot of this.shots) {
        const bar = document.createElement("button");
        bar.type = "button";
        bar.className = "console-bar";
        bar.dataset.lane = String(lane.lane);
        bar.dataset.shot = shot.shot;
        bar.style.setProperty("--c", lane.color);
        bar.style.setProperty("--lane", lane.lane);
        bar.style.left = `${(shot.world_start / w.duration) * 100}%`;
        bar.style.width = `calc(${((shot.world_end - shot.world_start) / w.duration) * 100}% - 2px)`;
        const name = document.createElement("strong");
        name.textContent = shotLabel(shot.shot);
        bar.append(name);
        bar.title = `${this.whereFor(shot)}${shot.registered ? "" : " · not merged into the world"}`;
        bar.setAttribute("aria-label", `${lane.label} · ${bar.title}`);
        track.insertBefore(bar, this.el.playhead);
        this.bars.set(`${lane.lane}|${shot.shot}`, bar);
      }
    }
    // 刻度间隔取让刻度不超过 12 个的最小整数秒；起点的刻度文字从刻度处往右写，终点的刻度文字从刻度处往左写
    const step = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => w.duration / s <= 12);
    if (!step) throw new Error(`世界时长 ${w.duration} 秒超出时间线刻度范围`);
    const ticks = [];
    for (let t = 0; t <= w.duration + 1e-6; t += step) {
      const tick = document.createElement("span");
      tick.style.left = `${(t / w.duration) * 100}%`;
      tick.textContent = clock(t, 0);
      if (t === 0) tick.className = "start";
      else if (Math.abs(t - w.duration) < 1e-6) tick.className = "end";
      ticks.push(tick);
    }
    this.el.ticks.replaceChildren(...ticks);
    this.el.playhead.setAttribute("aria-valuemax", String(w.duration));
  }

  // ---------- three.js ----------

  initThree() {
    const canvas = this.el.canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.scene3d = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FREE_FOV, 1, 0.03, 400);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !this.reduce;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => {
      this.dirty = true;
    });
    // 用户自己转动视角后不再套用全景视角，按钮也不再显示为选中
    this.controls.addEventListener("start", () => {
      this.anim = null;
      this.setPreset(null);
    });
    this.cloudGroup = new THREE.Group();
    this.dynGroup = new THREE.Group();
    this.roomGroup = new THREE.Group();
    this.pathGroup = new THREE.Group();
    this.scene3d.add(this.cloudGroup, this.dynGroup, this.roomGroup, this.pathGroup);
    this.pxScale = 1;
    this.pxRatio = 1;
    new ResizeObserver(() => this.resize()).observe(this.el.viewer);
  }

  resize() {
    const w = this.el.viewer.clientWidth;
    const h = this.el.viewer.clientHeight;
    if (!w || !h) return;
    this.pxRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pxRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.tuneAll();
    if (this.state.preset === "house" && this.ready) {
      this.anim = null;
      this.applyView(this.houseView());
    }
    this.dirty = true;
  }

  // 点的像素大小与视场角有关，视场角变了要重算
  tuneAll() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.pxScale = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.pointMaterials.forEach((m) => this.tunePoints(m));
  }

  // 点最小画 2 个 CSS 像素：全景视角离房子十几米，按点距算出来不到 1 个像素，2 个像素时远处的墙面和地面连成片
  tunePoints(material) {
    material.uniforms.uScale.value = this.pxScale;
    material.uniforms.uMinPx.value = 2 * this.pxRatio;
    material.uniforms.uMaxPx.value = 18 * this.pxRatio;
  }

  pointMaterial(size, withT1) {
    const cut = this.world.static.cut_height;
    const material = new THREE.ShaderMaterial({
      defines: withT1 ? { USE_T1: "" } : {},
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: size },
        uScale: { value: 1 },
        uCut: { value: cut === null ? 1e6 : cut },
        uMinPx: { value: 1 },
        uMaxPx: { value: 18 },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
    });
    this.tunePoints(material);
    this.pointMaterials.push(material);
    return material;
  }

  roomRadius(room) {
    const [x0, x1, z0, z1] = room.bounds;
    return 0.5 * Math.hypot(x1 - x0, z1 - z0);
  }

  // 每个房间的地面轮廓（左右墙在门的位置断开，靠观众的一侧不画）和门框，浅灰、半透明
  buildRooms3d() {
    const lines = [];
    for (const room of this.world.rooms) {
      const [x0, x1, z0, z1] = room.bounds;
      const y = 0.015;
      for (const [side, x] of [
        ["left", x0],
        ["right", x1],
      ]) {
        let z = z0;
        for (const d of room.doors.filter((door) => door.side === side).sort((a, b) => a.z - b.z)) {
          lines.push(x, y, z, x, y, d.z - d.width / 2);
          z = d.z + d.width / 2;
          const za = d.z - d.width / 2;
          const zb = d.z + d.width / 2;
          lines.push(x, 0, za, x, d.height, za, x, d.height, za, x, d.height, zb, x, d.height, zb, x, 0, zb);
        }
        lines.push(x, y, z, x, y, z1);
      }
      lines.push(x0, y, z0, x1, y, z0);
    }
    const material = new LineMaterial({
      color: new THREE.Color(0xd8dde6),
      linewidth: 1.4,
      transparent: true,
      opacity: 0.3,
      depthTest: false,
      depthWrite: false,
    });
    const outline = new LineSegments2(new LineSegmentsGeometry().setPositions(lines), material);
    outline.renderOrder = 2;
    outline.frustumCulled = false;
    this.roomGroup.add(outline);
  }

  // 全景视角：从房子朝观众的一侧斜上方看过去，所有房间包围盒（地面到 2.2 m）的角都在画面里（四周留 8%），
  // 各段相机的位置也都在画面里（四周留 10%）。先按屏幕上的范围把注视点移到中间，再求距离，反复三次
  houseView() {
    const corners = [];
    for (const room of this.world.rooms) {
      const [x0, x1, z0, z1] = room.bounds;
      for (const x of [x0, x1]) for (const y of [0, FRAME_TOP]) for (const z of [z0, z1]) corners.push(new THREE.Vector3(x, y, z));
    }
    const cameras = [];
    for (const seg of this.world.segments) {
      if (!seg.cams) continue;
      for (let i = 0; i < seg.cameras.frames; i += 15) {
        if (this.camAt(seg, i)) cameras.push(new THREE.Vector3().fromArray(seg.cams.pos, i * 3));
      }
    }
    const target = new THREE.Vector3();
    corners.forEach((p) => target.add(p));
    target.divideScalar(corners.length);
    const elevation = THREE.MathUtils.degToRad(52);
    const dir = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    const probe = this.camera.clone();
    probe.fov = FREE_FOV;
    probe.updateProjectionMatrix();
    const v = new THREE.Vector3();
    const place = (dist) => {
      probe.position.copy(target).addScaledVector(dir, dist);
      probe.lookAt(target);
      probe.updateMatrixWorld();
    };
    const within = (points, limit) =>
      points.every((p) => {
        v.copy(p).project(probe);
        return v.z > -1 && v.z < 1 && Math.abs(v.x) <= limit && Math.abs(v.y) <= limit;
      });
    let far = 0;
    for (const p of corners) far = Math.max(far, p.distanceTo(target));
    const fit = () => {
      let lo = 0.1;
      let hi = far * 8 + 1;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2;
        place(mid);
        if (within(corners, 0.92) && within(cameras, 0.9)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let dist = fit();
    for (let round = 0; round < 3; round++) {
      place(dist);
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of corners.concat(cameras)) {
        v.copy(p).project(probe);
        x0 = Math.min(x0, v.x);
        x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y);
        y1 = Math.max(y1, v.y);
      }
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad(probe.fov) / 2);
      target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 0), ((x0 + x1) / 2) * halfH * probe.aspect);
      target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 1), ((y0 + y1) / 2) * halfH);
      dist = fit();
    }
    return { position: target.clone().addScaledVector(dir, dist), target };
  }

  applyView(view) {
    // 先关掉阻尼更新一次，清掉拖动留下的惯性，新视角不会再被带着转
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    this.setFov(FREE_FOV);
    this.controls.enabled = true;
    this.camera.position.copy(view.position);
    this.controls.target.copy(view.target);
    const reach = view.position.distanceTo(view.target);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = reach * 3;
    this.camera.far = reach * 12;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }

  setFov(fov) {
    if (Math.abs(this.camera.fov - fov) < 1e-6) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.tuneAll();
  }

  setPreset(id) {
    this.state.preset = id;
    for (const chip of this.el.chips.querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip.dataset.view === id));
  }

  // 全景按钮：0.7 秒平滑移过去（减少动态效果时直接切过去）；从相机看：点云视角跟着大画面那个角度的相机走
  goTo(id) {
    if (id === "camera") {
      this.anim = null;
      this.setPreset("camera");
      this.controls.enabled = false;
      this.dirty = true;
      return;
    }
    const wasCamera = this.state.preset === "camera";
    this.setPreset("house");
    const view = this.houseView();
    if (this.reduce || wasCamera) {
      this.applyView(view);
      return;
    }
    this.anim = {
      from: { position: this.camera.position.clone(), target: this.controls.target.clone() },
      to: view,
      start: performance.now(),
      duration: 700,
    };
  }

  // 离开“从相机看”：保持当前看到的画面，注视点放在视线前方 2 米处，之后可以自由转动
  leaveCamera() {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.setPreset(null);
    this.setFov(FREE_FOV);
    this.controls.target.copy(this.camera.position).addScaledVector(forward, 2);
    this.controls.enabled = true;
    this.controls.update();
    this.dirty = true;
  }

  // 从相机看：位置、朝向与大画面里正在放的那一段当前时刻的相机相同，竖直视场角按当前帧的内参 fy 和画幅高算。
  // 这一刻没有相机（相机断开的区间外）时，点云视角停在原处
  followCamera() {
    const seg = this.view.lead;
    if (!seg || !seg.path || !seg.path.valid) return;
    const p = seg.path;
    const fys = seg.cams.fys;
    const fy = p.frac > 0 ? fys[p.frame] + (fys[p.frame + 1] - fys[p.frame]) * p.frac : fys[p.frame];
    this.camera.position.copy(p.marker.position);
    this.camera.quaternion.copy(p.marker.quaternion);
    this.camera.updateMatrixWorld();
    this.setFov(THREE.MathUtils.radToDeg(2 * Math.atan(seg.image[1] / 2 / fy)));
    this.dirty = true;
  }

  stepAnimation(now) {
    const a = this.anim;
    const u = smooth(clamp((now - a.start) / a.duration, 0, 1));
    if (u >= 1) {
      this.anim = null;
      this.applyView(a.to);
      return;
    }
    this.camera.position.copy(a.from.position).lerp(a.to.position, u);
    this.controls.target.copy(a.from.target).lerp(a.to.target, u);
    this.dirty = true;
  }

  // ---------- 数据：房子点云、相机、动态点 ----------

  async loadStatic() {
    const st = this.world.static;
    const buffer = await fetchBuffer(this.url(st.file), (loaded, total) => {
      this.progress = total ? loaded / total : null;
    });
    let end = 0;
    for (const g of st.groups) {
      end = Math.max(end, g.pos_offset + g.count * 6, g.rgb_offset + g.count * 3);
      if (g.t1_offset !== undefined) end = Math.max(end, g.t1_offset + g.count * 2);
    }
    if (end !== buffer.byteLength) throw new Error(`${st.file}: ${buffer.byteLength} bytes, sections end at ${end}`);
    const lo = st.bbox_min;
    const hi = st.bbox_max;
    this.groups = st.groups.map((g) => {
      const n = g.count;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Uint16Array(buffer, g.pos_offset, n * 3), 3, true));
      geometry.setAttribute("aColor", new THREE.BufferAttribute(new Uint8Array(buffer, g.rgb_offset, n * 3), 3, true));
      const t1 = g.t1_offset === undefined ? null : new Uint16Array(buffer, g.t1_offset, n);
      if (t1) geometry.setAttribute("aT1", new THREE.BufferAttribute(t1, 1));
      geometry.setDrawRange(0, 0);
      const points = new THREE.Points(geometry, this.pointMaterial(st.point_size, Boolean(t1)));
      points.position.fromArray(lo);
      points.scale.set(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      points.frustumCulled = false;
      this.cloudGroup.add(points);
      return {
        points,
        t1,
        times: Float64Array.from(g.t0, (row) => row[0]),
        cum: Uint32Array.from(g.t0, (row) => row[1]),
        drawn: -1,
      };
    });
    this.dirty = true;
  }

  // 出现时刻不晚于 t 的点数（表按出现时刻排好，二分查找）
  countAt(group, t) {
    let lo = 0;
    let hi = group.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (group.times[mid] <= t + 1e-6) lo = mid + 1;
      else hi = mid;
    }
    return lo ? group.cum[lo - 1] : 0;
  }

  ensureCameras(seg) {
    if (seg.camLoading) return seg.camLoading;
    seg.camLoading = fetchBuffer(this.url(seg.cameras.file)).then((buffer) => {
      const f = new Float32Array(buffer);
      const n = seg.cameras.frames;
      if (f.length !== n * seg.cameras.stride) throw new Error(`${seg.cameras.file}: ${f.length} floats for ${n} frames`);
      const pos = new Float32Array(n * 3);
      const quat = new Float32Array(n * 4);
      // 逐帧的 fy：新角度推近时焦距逐帧变化，从相机看时视场角按当前帧算
      const fys = new Float32Array(n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      let fx = 0;
      let fy = 0;
      let counted = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        // 没有相机的帧在文件里是 NaN，跳过，不参与平均焦距
        const ok = this.camAt(seg, i);
        if (ok !== Number.isFinite(f[o + 3])) throw new Error(`${seg.cameras.file}: frame ${i} ${ok ? "has no camera" : "should have no camera"}`);
        if (!ok) continue;
        m.set(f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7], f[o + 8], f[o + 9], f[o + 10], f[o + 11], 0, 0, 0, 1);
        q.setFromRotationMatrix(m);
        pos[i * 3] = f[o + 3];
        pos[i * 3 + 1] = f[o + 7];
        pos[i * 3 + 2] = f[o + 11];
        quat[i * 4] = q.x;
        quat[i * 4 + 1] = q.y;
        quat[i * 4 + 2] = q.z;
        quat[i * 4 + 3] = q.w;
        fys[i] = f[o + 13];
        fx += f[o + 12];
        fy += f[o + 13];
        counted++;
      }
      seg.cams = { pos, quat, fys, fx: fx / counted, fy: fy / counted };
      this.buildPath(seg);
      this.dirty = true;
    });
    return seg.camLoading;
  }

  // 一段的相机轨迹：只在播放头这一刻正在拍的房间里画，整条轨迹淡淡地画着；这一段正在拍时，过去的部分画虚线、半透明，
  // 未来的部分画实线，当前位置画一个视锥（画面上沿的小三角标出相机的上方）。颜色是这一段所在线的颜色。
  // 轨迹由相邻两帧之间的线段组成，两帧都有相机才连（相机断开的地方不连）
  buildPath(seg) {
    const radius = this.roomRadius(this.rooms.get(seg.scene));
    const color = new THREE.Color(seg.color);
    const n = seg.cameras.frames;
    const pos = seg.cams.pos;
    const starts = [];
    for (let i = 0; i + 1 < n; i++) if (this.camAt(seg, i) && this.camAt(seg, i + 1)) starts.push(i);
    const pairs = (order) => {
      const out = new Float32Array(order.length * 6);
      order.forEach((i, k) => out.set(pos.subarray(i * 3, i * 3 + 6), k * 6));
      return out;
    };
    const forward = pairs(starts);
    const backward = pairs([...starts].reverse());
    // before[i]：起点帧早于 i 的线段数。当前在第 i 帧时，过去部分画前 before[i] 段，未来部分（倒序存放）画其余的段
    const before = new Uint32Array(n);
    for (let i = 0, k = 0; i < n; i++) {
      while (k < starts.length && starts[k] < i) k++;
      before[i] = k;
    }
    const common = { color, transparent: true, depthTest: false, depthWrite: false };
    const ghostMaterial = new LineMaterial({ ...common, linewidth: 1.4, opacity: 0.3 });
    const ghost = new LineSegments2(new LineSegmentsGeometry().setPositions(forward), ghostMaterial);
    const pastMaterial = new LineMaterial({
      ...common,
      linewidth: 2,
      opacity: 0.6,
      dashed: true,
      dashSize: 0.03 * radius,
      gapSize: 0.024 * radius,
    });
    const futureMaterial = new LineMaterial({ ...common, linewidth: 2.8, opacity: 1 });
    const past = new LineSegments2(new LineSegmentsGeometry().setPositions(forward), pastMaterial);
    past.computeLineDistances();
    const future = new LineSegments2(new LineSegmentsGeometry().setPositions(backward), futureMaterial);
    // 实线和视锥下面各垫一条更宽的深色线，浅色的轨迹落在浅色墙面上也看得清
    const halo = { color: new THREE.Color(0x05070c), transparent: true, depthTest: false, depthWrite: false, opacity: 0.6 };
    const futureHaloMaterial = new LineMaterial({ ...halo, linewidth: 5.8 });
    const futureHalo = new LineSegments2(future.geometry, futureHaloMaterial);
    const depth = clamp(0.055 * radius, 0.08, 0.6);
    const hw = (depth * seg.image[0]) / 2 / seg.cams.fx;
    const hh = (depth * seg.image[1]) / 2 / seg.cams.fy;
    const c = [
      [-hw, hh, -depth],
      [hw, hh, -depth],
      [hw, -hh, -depth],
      [-hw, -hh, -depth],
    ];
    const lines = [];
    c.forEach((corner, i) => {
      lines.push(0, 0, 0, ...corner);
      lines.push(...corner, ...c[(i + 1) % 4]);
    });
    const top = [
      [-hw * 0.45, hh * 1.12, -depth],
      [0, hh * 1.7, -depth],
      [hw * 0.45, hh * 1.12, -depth],
    ];
    lines.push(...top[0], ...top[1], ...top[1], ...top[2], ...top[2], ...top[0]);
    const frustumMaterial = new LineMaterial({ ...common, linewidth: 2.2, opacity: 1 });
    const frustum = new LineSegments2(new LineSegmentsGeometry().setPositions(lines), frustumMaterial);
    const frustumHaloMaterial = new LineMaterial({ ...halo, linewidth: 5 });
    const frustumHalo = new LineSegments2(frustum.geometry, frustumHaloMaterial);
    const dotMaterial = new THREE.MeshBasicMaterial({ ...common });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(depth * 0.16, 18, 12), dotMaterial);
    ghost.renderOrder = 3;
    past.renderOrder = 4;
    futureHalo.renderOrder = 5;
    future.renderOrder = 6;
    frustumHalo.renderOrder = 7;
    frustum.renderOrder = 8;
    dot.renderOrder = 9;
    const marker = new THREE.Group();
    marker.add(frustumHalo, frustum, dot);
    const active = new THREE.Group();
    active.add(past, futureHalo, future, marker);
    // 画不画由 updatePaths 按播放头所在的房间决定
    ghost.visible = false;
    active.visible = false;
    this.pathGroup.add(ghost, active);
    seg.path = {
      ghost,
      active,
      past,
      future,
      marker,
      ghostMaterial,
      pastMaterial,
      futureMaterial,
      futureHaloMaterial,
      frustumMaterial,
      frustumHaloMaterial,
      before,
      count: starts.length,
      frame: 0,
      frac: 0,
      valid: false,
    };
  }

  // 动态点按段（镜头）存一份，这一段所有角度共用
  ensureDyn(seg) {
    const key = seg.dynamic.file;
    let d = this.dyns.get(key);
    if (d) return d.loading;
    d = { key, info: seg.dynamic, data: null, used: performance.now() };
    this.dyns.set(key, d);
    d.loading = fetchBuffer(this.url(key)).then((buffer) => {
      const frames = new DataView(buffer).getUint32(0, true);
      if (frames !== d.info.frames) throw new Error(`${key}: ${frames} frames, expected ${d.info.frames}`);
      const offsets = new Uint32Array(buffer, 4, frames + 1);
      const boxes = new Float32Array(buffer, 4 * (frames + 2), 6 * frames);
      const total = offsets[frames];
      const start = 4 * (frames + 2) + 24 * frames;
      if (buffer.byteLength !== start + total * 6) throw new Error(`${key}: size ${buffer.byteLength}`);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Uint8Array(buffer, start, total * 3), 3, true));
      geometry.setAttribute("aColor", new THREE.BufferAttribute(new Uint8Array(buffer, start + total * 3, total * 3), 3, true));
      geometry.setDrawRange(0, 0);
      const points = new THREE.Points(geometry, this.pointMaterial(this.world.static.point_size * 1.4, false));
      points.frustumCulled = false;
      points.visible = false;
      this.dynGroup.add(points);
      d.data = { points, offsets, boxes, frames, frame: -1 };
      this.evictDyn();
      this.dirty = true;
    });
    return d.loading;
  }

  evictDyn() {
    const loaded = [...this.dyns.values()].filter((d) => d.data);
    if (loaded.length <= DYN_KEEP) return;
    const showing = new Set(this.view.shots.map((seg) => seg.dynamic.file));
    loaded
      .filter((d) => !showing.has(d.key))
      .sort((a, b) => a.used - b.used)
      .slice(0, loaded.length - DYN_KEEP)
      .forEach((d) => {
        this.dynGroup.remove(d.data.points);
        d.data.points.geometry.dispose();
        d.data.points.material.dispose();
        this.pointMaterials.splice(this.pointMaterials.indexOf(d.data.points.material), 1);
        this.dyns.delete(d.key);
      });
  }

  // ---------- 时间 ----------

  intervalAt(t) {
    const list = this.intervals;
    if (t >= list[list.length - 1].end) return list[list.length - 1];
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].end <= t) lo = mid + 1;
      else hi = mid;
    }
    return list[lo];
  }

  local(seg, t = this.state.t) {
    return clamp(t - seg.world_start, 0, seg.duration);
  }

  setTime(t, byUser) {
    this.state.t = clamp(t, 0, this.world.duration);
    if (byUser) {
      this.needSeek = true;
      this.userMoved = performance.now();
    }
    this.dirty = true;
  }

  // 世界时间由大画面那个视频带着走；没有段在拍时按墙上时钟走；播到结尾从头再来
  advance(dt) {
    const s = this.state;
    if (!s.playing || s.scrubbing) return;
    const master = this.view.master;
    if (master) {
      // 用户刚改过时间（或视频栏刚换了视频）时先等视频对位，这一帧不跟视频走
      if (this.needSeek) return;
      const tile = this.tiles.get(master.id);
      const video = tile && tile.video;
      if (video && video.ended) this.setTime(master.world_end, false);
      else if (video && !video.paused && !video.seeking && video.readyState >= 3)
        this.setTime(master.world_start + video.currentTime, false);
    } else {
      this.setTime(s.t + dt, false);
    }
    if (s.t >= this.world.duration - 1e-3) {
      this.setTime(0, false);
      this.needSeek = true;
    }
  }

  togglePlay() {
    const s = this.state;
    if (s.playing) {
      s.playing = false;
    } else {
      if (s.t >= this.world.duration - 0.05) this.setTime(0, true);
      s.playing = true;
    }
    this.needSeek = true;
    this.dirty = true;
  }

  // 换大画面的角度；给了时间就同时跳到那一刻。点时间线、相机或轨迹都会开始播放
  chooseLane(lane, t, play) {
    this.state.lane = lane;
    for (const button of this.laneButtons) button.setAttribute("aria-pressed", String(Number(button.dataset.lane) === lane));
    if (t !== undefined) this.setTime(t, true);
    if (play) this.state.playing = true;
    this.needSeek = true;
    this.dirty = true;
  }

  // ---------- 每帧：哪些段在拍、视频栏放哪些、点云画到哪一刻 ----------

  update() {
    const s = this.state;
    const active = this.intervalAt(s.t).segs;
    // 大画面放选中的角度这一刻的视频；这个角度这一刻没有视频时放原片，走到它又有视频的地方自动换回来。
    // 小画面是这一刻有视频的其他角度，世界时间由大画面的视频带着走
    const lead = active.find((seg) => seg.lane === s.lane) || active.find((seg) => seg.lane === 0) || active[0] || null;
    const others = active.filter((seg) => seg !== lead).sort((a, b) => a.lane - b.lane);
    const master = lead;
    const shots = [...new Map(active.map((seg) => [seg.dynamic.file, seg])).values()];
    // 这一刻正在拍的房间：相机轨迹只画这些房间里的段
    const rooms = new Set(active.map((seg) => seg.scene));
    this.view = { active, rooms, shots, master, lead, tiles: lead ? [lead, ...others] : others };
    this.updateStatic();
    this.updatePaths(active, lead, rooms);
    this.updateDyn(shots);
    this.prefetch();
    this.updateFilm(lead, others);
    this.syncVideos();
    if (s.preset === "camera") this.followCamera();
    this.updateUI(active, lead);
  }

  updateStatic() {
    for (const g of this.groups) {
      const n = this.countAt(g, this.state.t);
      if (n !== g.drawn) {
        g.drawn = n;
        g.points.geometry.setDrawRange(0, n);
        this.dirty = true;
      }
      g.points.material.uniforms.uTime.value = this.state.t;
    }
  }

  // 其他房间的轨迹整条不画，也不响应点击和悬停（pick 只找画出来的轨迹）；世界时间走到另一个房间时随之切换
  updatePaths(active, lead, rooms) {
    const shown = new Set(active.map((seg) => seg.id));
    const through = this.state.preset === "camera";
    const quatA = new THREE.Quaternion();
    const quatB = new THREE.Quaternion();
    if (this.state.hover && !rooms.has(this.segments.get(this.state.hover).scene)) this.clearHover();
    for (const seg of this.world.segments) {
      if (!seg.path) continue;
      const p = seg.path;
      const here = rooms.has(seg.scene);
      if (p.ghost.visible !== here) {
        p.ghost.visible = here;
        this.dirty = true;
      }
      const on = shown.has(seg.id);
      const hot = this.state.hover === seg.id || seg === lead;
      p.ghostMaterial.opacity = this.state.hover === seg.id ? 0.75 : 0.3;
      p.ghostMaterial.linewidth = this.state.hover === seg.id ? 2.4 : 1.4;
      p.active.visible = on;
      if (!on) continue;
      const n = seg.cameras.frames;
      const f = this.local(seg) * seg.cameras.fps;
      const i = clamp(Math.floor(f), 0, n - 2);
      // 这一刻所在的帧没有相机（相机断开的区间外）：轨迹照画，相机标记和视锥不画，也就没有箭头。
      // 有相机、但下一帧没有时停在这一帧，不往没有相机的帧插值
      p.valid = this.camAt(seg, clamp(Math.floor(f), 0, n - 1));
      const frac = p.valid && this.camAt(seg, i) && this.camAt(seg, i + 1) ? clamp(f - i, 0, 1) : 0;
      const j = frac > 0 ? i + 1 : i;
      p.frame = i;
      p.frac = frac;
      p.past.geometry.instanceCount = p.before[i];
      p.past.visible = p.before[i] > 0;
      p.future.geometry.instanceCount = p.count - p.before[i];
      if (p.valid) {
        const pos = seg.cams.pos;
        p.marker.position.set(
          pos[i * 3] + (pos[j * 3] - pos[i * 3]) * frac,
          pos[i * 3 + 1] + (pos[j * 3 + 1] - pos[i * 3 + 1]) * frac,
          pos[i * 3 + 2] + (pos[j * 3 + 2] - pos[i * 3 + 2]) * frac,
        );
        quatA.fromArray(seg.cams.quat, i * 4);
        quatB.fromArray(seg.cams.quat, j * 4);
        p.marker.quaternion.slerpQuaternions(quatA, quatB, frac);
      }
      // 从相机看时，大画面这个相机自己的视锥不画（镜头就在视锥里）
      p.marker.visible = p.valid && !(through && seg === lead);
      p.futureMaterial.linewidth = hot ? 4 : 2.8;
      p.pastMaterial.linewidth = hot ? 3 : 2;
      p.frustumMaterial.linewidth = hot ? 3 : 2.2;
      p.futureHaloMaterial.linewidth = p.futureMaterial.linewidth + 3;
      p.frustumHaloMaterial.linewidth = p.frustumMaterial.linewidth + 2.8;
    }
  }

  // 这一刻在拍的每个镜头画它这一帧的动态点（人和被移动的物体），各角度共用一份，帧从镜头的世界起点算。
  // 相机断开的镜头，有相机的区间以外不画
  updateDyn(shots) {
    const want = new Set(shots.map((seg) => seg.dynamic.file));
    for (const d of this.dyns.values()) {
      if (d.data && !want.has(d.key) && d.data.points.visible) {
        d.data.points.visible = false;
        this.dirty = true;
      }
    }
    // 拖动时间线、或者暂停时连续按键快速跳过几段时，只显示已经读进来的动态点；播放中、或停在一个时刻 0.4 秒以后才读
    const settled = !this.state.scrubbing && (this.state.playing || performance.now() - this.userMoved > 400);
    for (const seg of shots) {
      const d = this.dyns.get(seg.dynamic.file);
      if (!d || !d.data) {
        if (!d && settled) this.ensureDyn(seg);
        continue;
      }
      const data = d.data;
      const i = clamp(Math.floor((this.state.t - seg.dynamic.world_start) * seg.dynamic.fps + 1e-6), 0, data.frames - 1);
      d.used = performance.now();
      const show = this.dynAt(seg.dynamic, this.state.t);
      if (data.points.visible !== show) {
        data.points.visible = show;
        this.dirty = true;
      }
      if (!show || i === data.frame) continue;
      data.frame = i;
      data.points.geometry.setDrawRange(data.offsets[i], data.offsets[i + 1] - data.offsets[i]);
      const b = data.boxes.subarray(i * 6, i * 6 + 6);
      data.points.position.set(b[0], b[1], b[2]);
      data.points.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      this.dirty = true;
    }
  }

  // 播放时提前准备接下来 3 秒要用到的视频
  prefetch() {
    const s = this.state;
    if (!s.playing) return;
    for (const iv of this.intervals) {
      if (iv.start > s.t && iv.start - s.t < 3) iv.segs.forEach((seg) => this.tileFor(seg));
    }
  }

  // ---------- 视频 ----------

  tileFor(seg) {
    let tile = this.tiles.get(seg.id);
    if (!tile) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "console-tile";
      el.dataset.seg = seg.id;
      el.style.setProperty("--c", seg.color);
      const video = document.createElement("video");
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.disablePictureInPicture = true;
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.poster = this.url(seg.poster);
      const cap = document.createElement("span");
      cap.className = "console-tile-cap";
      const name = document.createElement("strong");
      name.textContent = this.laneLabel(seg);
      const where = document.createElement("span");
      where.className = "console-tile-where";
      where.textContent = this.whereFor(seg);
      cap.append(name, where);
      const text = this.noteFor(seg);
      if (text) {
        const note = document.createElement("span");
        note.className = "console-tile-note";
        note.textContent = text;
        cap.append(note);
      }
      el.append(video, cap);
      el.addEventListener("click", () => {
        if (this.view.lead === seg) this.togglePlay();
        else this.chooseLane(seg.lane);
      });
      tile = { seg, el, video, used: 0 };
      this.tiles.set(seg.id, tile);
    }
    if (!tile.video.getAttribute("src")) tile.video.src = this.url(seg.video.file);
    tile.used = performance.now();
    return tile;
  }

  // 持有视频数据的播放器最多 VIDEO_KEEP 个：最近 2 秒没在视频栏里、也不是马上要播的视频，按最久没用的先释放
  releaseVideos() {
    const now = performance.now();
    const loaded = [...this.tiles.values()].filter((tile) => tile.video.getAttribute("src"));
    const idle = loaded.filter((tile) => now - tile.used > 2000).sort((a, b) => a.used - b.used);
    idle.slice(0, Math.max(0, loaded.length - VIDEO_KEEP)).forEach((tile) => {
      tile.video.pause();
      tile.video.removeAttribute("src");
      tile.video.load();
    });
  }

  // 视频栏：大画面是这一刻实际在放的那个角度，下面是这一刻有视频的其他角度的小画面
  updateFilm(lead, others) {
    const key = `${lead ? lead.id : ""}|${others.map((seg) => seg.id).join(",")}`;
    if (key === this.filmKey) return;
    this.filmKey = key;
    const shown = new Set([lead, ...others].filter(Boolean).map((seg) => seg.id));
    for (const tile of this.tiles.values()) {
      if (!shown.has(tile.seg.id)) tile.video.pause();
    }
    if (lead) {
      this.el.film.style.setProperty("--col-c", lead.color);
      const tile = this.tileFor(lead);
      tile.el.classList.add("lead");
      tile.el.setAttribute("aria-label", `${shotLabel(lead.shot)} from the ${this.laneLabel(lead)} angle. Activate to play or pause.`);
      this.el.lead.replaceChildren(this.leadSizer, tile.el);
    } else {
      this.el.lead.replaceChildren(this.leadSizer);
    }
    this.el.thumbs.replaceChildren(
      ...others.map((seg) => {
        const tile = this.tileFor(seg);
        tile.el.classList.remove("lead");
        tile.el.setAttribute("aria-label", `Show the ${this.laneLabel(seg)} angle in the large view`);
        return tile.el;
      }),
    );
    this.releaseVideos();
    this.needSeek = true;
  }

  syncVideos() {
    const s = this.state;
    const play = (video) =>
      video.play().catch((error) => {
        if (error.name === "AbortError") return;
        // 浏览器不允许自动播放（比如省电模式）：世界停在当前时刻，等用户按播放
        if (error.name === "NotAllowedError") {
          s.playing = false;
          this.dirty = true;
          return;
        }
        throw error;
      });
    const seek = this.needSeek;
    this.needSeek = false;
    for (const seg of this.view.tiles) {
      const tile = this.tiles.get(seg.id);
      tile.used = performance.now();
      const video = tile.video;
      const local = Math.min(this.local(seg), seg.duration - 0.001);
      const running = s.visible && s.playing && !s.scrubbing && this.local(seg) < seg.duration - 0.02;
      if (running) {
        const master = seg === this.view.master;
        if (seek || (video.paused && Math.abs(video.currentTime - local) > 0.05)) video.currentTime = local;
        else if (!master && !video.seeking && Math.abs(video.currentTime - local) > DRIFT) video.currentTime = local;
        if (video.paused) play(video);
      } else {
        if (!video.paused) video.pause();
        if (seek || (!video.seeking && Math.abs(video.currentTime - local) > 0.02)) video.currentTime = local;
      }
    }
  }

  // ---------- 箭头：从每个正在拍的相机指向它的视频 ----------

  toClient(vector, rect) {
    const v = vector.clone().project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  // 视频在点云左边时箭头指到视频右边缘的中点，在点云上方（窄屏叠放）时指到视频下边缘的中点
  arrowEnd(box, canvas) {
    if (box.right <= canvas.left + 1) return { x: box.right + 4, y: box.top + box.height / 2, side: true };
    return { x: box.left + box.width / 2, y: box.bottom + 4, side: false };
  }

  drawArrows() {
    const svg = this.el.arrows;
    const stage = this.el.stage.getBoundingClientRect();
    const canvas = this.el.canvas.getBoundingClientRect();
    const keep = new Set();
    this.arrowCoords = [];
    for (const seg of this.view.active) {
      const tile = this.tiles.get(seg.id);
      if (!seg.path || !seg.path.active.visible || !seg.path.marker.visible || !tile || !tile.el.isConnected) continue;
      const start = this.toClient(seg.path.marker.position, canvas);
      if (!start || start.x < canvas.left || start.x > canvas.right || start.y < canvas.top || start.y > canvas.bottom) continue;
      const end = this.arrowEnd(tile.video.getBoundingClientRect(), canvas);
      const x1 = start.x - stage.left;
      const y1 = start.y - stage.top;
      const x2 = end.x - stage.left;
      const y2 = end.y - stage.top;
      const c1 = end.side ? [x1 + (x2 - x1) * 0.5, y1] : [x1, y1 + (y2 - y1) * 0.5];
      const c2 = end.side ? [x2 + Math.max(30, (x1 - x2) * 0.35), y2] : [x2, y2 + Math.max(30, (y1 - y2) * 0.35)];
      let g = this.arrows.get(seg.id);
      if (!g) {
        g = document.createElementNS(SVG_NS, "g");
        g.dataset.seg = seg.id;
        const line = document.createElementNS(SVG_NS, "path");
        const head = document.createElementNS(SVG_NS, "path");
        head.setAttribute("class", "head");
        const ring = document.createElementNS(SVG_NS, "circle");
        ring.setAttribute("r", "6");
        g.append(line, head, ring);
        svg.append(g);
        this.arrows.set(seg.id, g);
      }
      const [line, head, ring] = g.children;
      line.setAttribute("stroke", seg.color);
      line.setAttribute("d", `M${x1.toFixed(1)} ${y1.toFixed(1)} C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`);
      // 箭头沿曲线末端的切线方向
      const ang = Math.atan2(y2 - c2[1], x2 - c2[0]);
      const size = 10;
      const p1 = [x2 - size * Math.cos(ang - 0.45), y2 - size * Math.sin(ang - 0.45)];
      const p2 = [x2 - size * Math.cos(ang + 0.45), y2 - size * Math.sin(ang + 0.45)];
      head.setAttribute("fill", seg.color);
      head.setAttribute("d", `M${x2.toFixed(1)} ${y2.toFixed(1)} L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)} Z`);
      ring.setAttribute("cx", x1.toFixed(1));
      ring.setAttribute("cy", y1.toFixed(1));
      ring.setAttribute("stroke", seg.color);
      keep.add(seg.id);
      this.arrowCoords.push({ id: seg.id, start: [start.x, start.y], end: [end.x, end.y] });
    }
    for (const [id, g] of this.arrows) {
      if (!keep.has(id)) {
        g.remove();
        this.arrows.delete(id);
      }
    }
  }

  // ---------- 界面文字和时间线状态 ----------

  updateUI(active, lead) {
    const s = this.state;
    const w = this.world;
    this.el.playhead.style.left = `${(s.t / w.duration) * 100}%`;
    const text = clock(s.t);
    if (this.el.time.textContent !== text) {
      this.el.time.textContent = text;
      // 与钟面一样截到十分之一秒
      this.el.playhead.setAttribute("aria-valuenow", (Math.floor(s.t * 10 + 1e-6) / 10).toFixed(1));
      this.el.playhead.setAttribute("aria-valuetext", text);
    }
    // 时间轴：播放头所在镜头的条（每条线都有）亮起，选中的那条线上的这一根描边
    const shot = active.length ? active[0].shot : "";
    const key = [s.playing, s.lane, shot].join("|");
    if (key !== this.uiKey) {
      this.uiKey = key;
      this.el.play.innerHTML = s.playing ? ICON_PAUSE : ICON_PLAY;
      this.el.play.setAttribute("aria-label", s.playing ? "Pause" : "Play");
      for (const [id, bar] of this.bars) {
        bar.classList.toggle("live", bar.dataset.shot === shot);
        bar.classList.toggle("chosen", id === `${s.lane}|${shot}`);
      }
    }
    this.el.loading.hidden = this.ready;
    if (!this.ready) {
      const pct = this.progress === null ? null : Math.round(this.progress * 100);
      const label = pct === null ? "Loading the world" : `Loading the world · ${pct}%`;
      if (this.el.loadingText.textContent !== label) this.el.loadingText.textContent = label;
      this.el.loadingBar.style.setProperty("--progress", `${pct || 0}%`);
    }
  }

  render() {
    this.renderer.render(this.scene3d, this.camera);
  }

  loop(now) {
    this.raf = 0;
    if (!this.state.visible || document.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.lastNow ? Math.min(0.25, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    this.advance(dt);
    if (this.anim) this.stepAnimation(now);
    if (this.state.preset !== "camera" && this.controls.update()) this.dirty = true;
    this.update();
    if (this.dirty) {
      this.dirty = false;
      this.render();
    }
    this.drawArrows();
  }

  show() {
    this.state.visible = true;
    this.lastNow = 0;
    this.needSeek = true;
    this.dirty = true;
    this.resize();
    if (!this.raf && !document.hidden) this.raf = requestAnimationFrame(this.loop);
  }

  hide() {
    this.state.visible = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const tile of this.tiles.values()) tile.video.pause();
  }

  // ---------- 输入 ----------

  timeAtX(clientX) {
    const rect = this.el.track.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * this.world.duration;
  }

  // 点在哪一段上：正在拍的相机标记（取当前时刻），或者画出来的一段轨迹（取轨迹上离点击处最近的那一帧）。
  // 没画出来的轨迹（不在正在拍的房间里）不算
  pick(clientX, clientY) {
    const rect = this.el.canvas.getBoundingClientRect();
    const point = new THREE.Vector3();
    let best = null;
    for (const seg of this.world.segments) {
      if (!seg.path || !seg.path.ghost.visible) continue;
      if (seg.path.active.visible && seg.path.marker.visible) {
        const m = this.toClient(seg.path.marker.position, rect);
        if (m) {
          const d = Math.hypot(m.x - clientX, m.y - clientY) - 8;
          if (d < 12 && (!best || d < best.d)) best = { seg, d, frame: null };
        }
      }
      const pos = seg.cams.pos;
      let prev = null;
      for (let i = 0; i < seg.cameras.frames; i += 2) {
        if (!this.camAt(seg, i)) {
          prev = null;
          continue;
        }
        const p = this.toClient(point.fromArray(pos, i * 3), rect);
        if (p && prev) {
          const d = segmentDistance(clientX, clientY, prev.x, prev.y, p.x, p.y);
          if (d < 8 && (!best || d < best.d)) {
            const near = Math.hypot(prev.x - clientX, prev.y - clientY) < Math.hypot(p.x - clientX, p.y - clientY);
            best = { seg, d, frame: near ? i - 2 : i };
          }
        }
        prev = p;
      }
    }
    return best;
  }

  onKey(event) {
    const step = event.shiftKey ? 5 : 1;
    const s = this.state;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        this.setTime(s.t + step, true);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        this.setTime(s.t - step, true);
        break;
      case "PageUp":
        this.setTime(s.t + 10, true);
        break;
      case "PageDown":
        this.setTime(s.t - 10, true);
        break;
      case "Home":
        this.setTime(0, true);
        break;
      case "End":
        this.setTime(this.world.duration, true);
        break;
      case " ":
        this.togglePlay();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  bindEvents() {
    const { canvas, track, playhead, play, chips, laneLabels } = this.el;
    document.addEventListener("atas:view", (event) => {
      if (event.detail === "console") this.show();
      else this.hide();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        for (const tile of this.tiles.values()) tile.video.pause();
      } else if (this.state.visible) {
        this.show();
      }
    });
    play.addEventListener("click", () => this.togglePlay());
    chips.addEventListener("click", (event) => {
      const chip = event.target.closest("button[data-view]");
      if (chip && this.ready) this.goTo(chip.dataset.view);
    });
    laneLabels.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-lane]");
      if (button) this.chooseLane(Number(button.dataset.lane));
    });
    playhead.addEventListener("keydown", (event) => this.onKey(event));
    canvas.addEventListener("keydown", (event) => this.onKey(event));
    // 点一根条：选中这条线，跳到点的时刻（落在这个镜头里）并播放；键盘在条上按回车或空格时取播放头所在时刻
    const pickBar = (bar, t) => {
      const shot = this.shotMap.get(bar.dataset.shot);
      this.chooseLane(Number(bar.dataset.lane), clamp(t, shot.world_start, shot.world_end - 0.5 / shot.fps), true);
    };
    track.addEventListener("keydown", (event) => {
      const bar = event.target.closest(".console-bar");
      if (bar && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        pickBar(bar, this.state.t);
      }
    });

    // 时间线：按下即定位，拖动即滑动；在一根条上按下松开（没拖动）就是点这根条
    track.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      track.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.clientX, moved: false, bar: event.target.closest(".console-bar") };
      this.state.scrubbing = true;
      this.setTime(this.timeAtX(event.clientX), true);
    });
    track.addEventListener("pointermove", (event) => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      if (Math.abs(event.clientX - this.drag.x) > 4) this.drag.moved = true;
      this.setTime(this.timeAtX(event.clientX), true);
    });
    const release = (event, cancelled) => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      const { bar, moved } = this.drag;
      this.drag = null;
      this.state.scrubbing = false;
      if (!cancelled && moved) this.setTime(this.timeAtX(event.clientX), true);
      if (!cancelled && !moved && bar) pickBar(bar, this.timeAtX(event.clientX));
      this.needSeek = true;
      this.dirty = true;
    };
    track.addEventListener("pointerup", (event) => release(event, false));
    track.addEventListener("pointercancel", (event) => release(event, true));

    // 点云：点击（不拖动）相机标记换到那个角度、时间不变；点击轨迹换到那个角度并跳到轨迹上那一帧；悬停时显示名字。
    // 从相机看的时候在点云上按下就回到自由视角
    canvas.addEventListener("pointerdown", (event) => {
      if (this.state.preset === "camera") this.leaveCamera();
      this.press = { x: event.clientX, y: event.clientY, at: performance.now() };
    });
    canvas.addEventListener("pointerup", (event) => {
      const press = this.press;
      this.press = null;
      if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5 || performance.now() - press.at > 600) return;
      const hit = this.pick(event.clientX, event.clientY);
      if (!hit) return;
      if (hit.frame === null) this.chooseLane(hit.seg.lane, undefined, true);
      else this.chooseLane(hit.seg.lane, hit.seg.world_start + hit.frame / hit.seg.cameras.fps, true);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (event.buttons) return;
      const hit = this.pick(event.clientX, event.clientY);
      const id = hit ? hit.seg.id : null;
      canvas.classList.toggle("pick", Boolean(hit));
      if (hit) {
        const rect = this.el.viewer.getBoundingClientRect();
        const label = this.el.pick;
        const when = hit.frame === null ? "now" : clock(hit.seg.world_start + hit.frame / hit.seg.cameras.fps);
        label.textContent = `${this.laneLabel(hit.seg)} · ${shotLabel(hit.seg.shot)} · ${when}`;
        label.style.transform = `translate(${event.clientX - rect.left + 14}px, ${event.clientY - rect.top + 12}px)`;
        label.hidden = false;
      } else {
        this.el.pick.hidden = true;
      }
      if (id !== this.state.hover) {
        this.state.hover = id;
        this.dirty = true;
      }
    });
    canvas.addEventListener("pointerleave", () => this.clearHover());
  }

  // 悬停的名字收起，轨迹恢复原样
  clearHover() {
    this.el.pick.hidden = true;
    this.el.canvas.classList.remove("pick");
    if (this.state.hover) {
      this.state.hover = null;
      this.dirty = true;
    }
  }

  // ---------- 给测试读的状态 ----------

  snapshot() {
    const s = this.state;
    const rect = this.el.canvas.getBoundingClientRect();
    const removed = this.groups.find((g) => g.t1);
    let removedVisible = 0;
    if (removed) {
      const limit = Math.max(0, removed.drawn);
      for (let i = 0; i < limit; i++) if (removed.t1[i] * 0.01 > s.t) removedVisible++;
    }
    const kept = this.groups.find((g) => !g.t1);
    return {
      t: s.t,
      playing: s.playing,
      scrubbing: s.scrubbing,
      lane: s.lane,
      preset: s.preset,
      ready: this.ready,
      running: Boolean(this.raf),
      active: this.view.active.map((seg) => seg.id),
      master: this.view.master ? this.view.master.id : null,
      lead: this.view.lead ? this.view.lead.id : null,
      thumbs: [...this.el.thumbs.querySelectorAll(".console-tile")].map((el) => el.dataset.seg),
      // 这一刻正在拍的房间，以及每段轨迹画了哪些部分：整条淡线、正在拍的部分（过去虚线、未来实线）、相机标记
      rooms: [...this.view.rooms],
      paths: this.world.segments
        .filter((seg) => seg.path)
        .map((seg) => ({
          id: seg.id,
          scene: seg.scene,
          ghost: seg.path.ghost.visible,
          active: seg.path.active.visible,
          marker: seg.path.active.visible && seg.path.marker.visible,
        })),
      visible: this.view.active.map((seg) => {
        const p = seg.path;
        if (!p || !p.active.visible) return { id: seg.id, drawn: false };
        const screen = this.toClient(p.marker.position, rect);
        return {
          id: seg.id,
          drawn: true,
          valid: p.valid,
          markerShown: p.marker.visible,
          frame: p.frame,
          frac: p.frac,
          past: p.past.visible ? p.past.geometry.instanceCount : 0,
          future: p.future.geometry.instanceCount,
          marker: p.marker.position.toArray(),
          quaternion: p.marker.quaternion.toArray(),
          screen: screen && [screen.x, screen.y],
        };
      }),
      // 画出来、但这一刻没在拍的段：轨迹中间那一帧（相机断开的段取有相机的最长一段区间的中间）的屏幕位置与对应的世界时间
      idle: this.world.segments
        .filter((seg) => seg.path && seg.path.ghost.visible && !seg.path.active.visible)
        .map((seg) => {
          const f = this.midFrame(seg);
          const at = this.toClient(new THREE.Vector3().fromArray(seg.cams.pos, f * 3), rect);
          return { id: seg.id, t: seg.world_start + f / seg.cameras.fps, screen: at && [at.x, at.y] };
        }),
      tiles: [...this.el.stage.querySelectorAll(".console-tile")].map((el) => {
        const tile = this.tiles.get(el.dataset.seg);
        const box = tile.video.getBoundingClientRect();
        return {
          id: tile.seg.id,
          lead: this.el.lead.contains(el),
          paused: tile.video.paused,
          currentTime: tile.video.currentTime,
          rect: [box.left, box.top, box.width, box.height],
        };
      }),
      videos: [...this.tiles.values()].map((tile) => ({ id: tile.seg.id, paused: tile.video.paused })),
      arrows: this.arrowCoords || [],
      dyn: [...this.dyns.values()]
        .filter((d) => d.data)
        .map((d) => ({ file: d.key, frame: d.data.frame, shown: d.data.points.visible, count: d.data.points.geometry.drawRange.count })),
      static: {
        kept: kept ? kept.drawn : 0,
        removedDrawn: removed ? removed.drawn : 0,
        removedVisible,
      },
      camera: {
        position: this.camera.position.toArray(),
        quaternion: this.camera.quaternion.toArray(),
        target: this.controls.target.toArray(),
        fov: this.camera.fov,
        aspect: this.camera.aspect,
      },
      canvas: [rect.left, rect.top, rect.width, rect.height],
      // 上一次绘制画出的点数（房子点云两组加这一刻各镜头的动态点）
      drawnPoints: this.renderer.info.render.points,
    };
  }
}

export async function mountConsole(root) {
  const app = new WorldConsole(root);
  await app.start();
  return app;
}
