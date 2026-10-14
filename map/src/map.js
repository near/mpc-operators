// @ts-check
//
// The map. Three stacked layers inside one container:
//
//   ┌──────────────── .map ────────────────┐
//   │ canvas.base   land, borders, p2p mesh │  redrawn on resize / theme change
//   │ canvas.fx     signing rounds          │  redrawn every animation frame
//   │ svg.nodes     markers, labels, hover  │  DOM, so it stays crisp + focusable
//   └───────────────────────────────────────┘
//
// Zoom and pan rescale the projection rather than the pixels, so coastlines
// stay sharp, markers keep their size, and clustered nodes pull apart as you
// zoom in. Wheel (or trackpad pinch), drag, touch pinch, double-click and the
// +/−/Fit buttons all drive the same view transform.
//
// One signing round, as animated (times in ms from the start). Every round
// in flight plays in its own color from the --round-N palette, so parallel
// signatures stay apart, and its leader wears a ring and a "leader" tag from
// start to finish.
//
//   0     request lands on v1.signer          hub ring
//   150   every node sees it on-chain         faint hub → node ticks
//   900   peers send shares to the leader     peer → leader particles
//   2300  leader submits respond()            leader → hub particle, thicker
//   3000  signature returned to the caller    hub flash + destination label

import { geoGraticule10, geoNaturalEarth1, geoPath } from "https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm";
import { feature, mesh } from "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm";
import { spreadOverlapping } from "./lib/geo.js";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";
const SVG_NS = "http://www.w3.org/2000/svg";
const ROUND_MS = 3600;
const MARKER_SPACING_PX = 17;
const MAX_ZOOM = 16;
/** Size of the --round-N palette in site.css. */
const ROUND_COLORS = 5;

/**
 * @typedef {{
 *   account: string,
 *   lat: number,
 *   lon: number,
 *   label: string,
 *   tee: "tdx" | "mock" | "none",
 *   delivered: number,
 * }} MapNode
 * @typedef {MapNode & { x: number, y: number, cx: number, cy: number }} PlacedNode
 * @typedef {{
 *   id: string,
 *   leader: string,
 *   peers: string[],
 *   caption: string,
 *   startedAt: number,
 *   color: number,
 * }} Round palette index in `color`; no two rounds in flight share one
 * @typedef {{ x: number, y: number }} Point
 */

/**
 * Quadratic curve that bows sideways, so arcs between nearby points still read.
 * @param {Point} a
 * @param {Point} b
 * @param {number} bend fraction of the distance
 */
function curve(a, b, bend = 0.2) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c = { x: mx - dy * bend, y: my + dx * bend };
  /** @param {number} t */
  return (t) => {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  };
}

/** @param {number} t */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** @param {number} v */
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Offset for the span [lo, hi], scaled by k, moved as little as possible from
 * `t` so it covers [0, size] — or sits centred, when it is the shorter one.
 * @param {number} t
 * @param {number} lo
 * @param {number} hi
 * @param {number} k
 * @param {number} size
 */
const cover = (t, lo, hi, k, size) =>
  (hi - lo) * k >= size ? clamp(t, size - hi * k, -lo * k) : (size - (lo + hi) * k) / 2;

export class NetworkMap {
  /** @type {PlacedNode[]} */
  #nodes = [];
  /** @type {Map<string, PlacedNode>} */
  #byAccount = new Map();
  /** @type {Point} */
  #hub = { x: 0, y: 0 };
  /** @type {Round[]} */
  #rounds = [];
  /** @type {unknown} */
  #world = null;
  #width = 0;
  #height = 0;
  #dpr = 1;
  #frame = 0;
  #reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  /** @type {Record<string, string>} */
  #colors = {};
  /** @type {(account: string | null) => void} */
  #onHover = () => {};
  /** @type {(account: string) => void} */
  #onSelect = () => {};
  /** @type {string | null} */
  #highlighted = null;
  /** The --round-N colors, read from CSS. @type {string[]} */
  #palette = [];
  /** @type {(live: Map<string, number>) => void} */
  #onRounds = () => {};
  #liveKey = "";
  /** Zoom and pan on top of the fitted projection: screen = fitted * k + (x, y). */
  #view = { k: 1, x: 0, y: 0 };
  /**
   * The globe's outline in fitted screen coordinates; panning stays within it.
   * @type {[[number, number], [number, number]]}
   */
  #sphere = [[0, 0], [0, 0]];
  #renderQueued = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #hintTimer;

  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.base = document.createElement("canvas");
    this.base.className = "map-base";
    this.fx = document.createElement("canvas");
    this.fx.className = "map-fx";
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("map-nodes");
    this.svg.setAttribute("role", "group");
    this.svg.setAttribute("aria-label", "MPC nodes");
    this.controls = document.createElement("div");
    this.controls.className = "map-controls";
    this.controls.innerHTML = `
      <button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
      <button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
      <button type="button" data-zoom="fit" aria-label="Fit all nodes" title="Fit all nodes">Fit</button>`;
    this.hint = document.createElement("p");
    this.hint.className = "map-hint";
    this.hint.textContent = `Hold ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} and scroll to zoom`;
    container.append(this.base, this.fx, this.svg, this.controls, this.hint);
    this.#bindGestures();

    new ResizeObserver(() => this.#layout()).observe(container);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.#layout());
    new MutationObserver(() => this.#layout()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    fetch(WORLD_URL)
      .then((r) => r.json())
      .then((world) => {
        this.#world = world;
        this.#layout();
      })
      .catch(() => {
        container.dataset.worldFailed = "true";
      });
  }

  /** @param {(account: string | null) => void} handler */
  onHover(handler) {
    this.#onHover = handler;
  }

  /**
   * A node was clicked or activated from the keyboard.
   * @param {(account: string) => void} handler
   */
  onSelect(handler) {
    this.#onSelect = handler;
  }

  /** @param {MapNode[]} nodes */
  setNodes(nodes) {
    this.#nodes = nodes.map((n) => ({ ...n, x: 0, y: 0, cx: 0, cy: 0 }));
    this.#layout();
  }

  /**
   * Resizes markers by how many signatures each node delivered.
   * @param {Map<string, number>} delivered
   */
  setDelivered(delivered) {
    for (const node of this.#nodes) node.delivered = delivered.get(node.account) ?? 0;
    this.#drawNodes();
  }

  /**
   * Starts one signing round. Rounds overlap freely; each gets a color no
   * other round in flight is using, and a replay keeps its color.
   * @param {Omit<Round, "startedAt" | "color">} round
   */
  play(round) {
    if (!this.#byAccount.has(round.leader)) return;
    const color = this.#rounds.find((r) => r.id === round.id)?.color ?? this.#freeColor();
    this.#rounds.push({ ...round, startedAt: performance.now(), color });
    if (this.#rounds.length > 12) this.#rounds.shift();
    this.#syncRounds();
    if (this.#frame === 0) this.#frame = requestAnimationFrame((t) => this.#draw(t));
  }

  /**
   * Called with round id → palette index whenever the set in flight changes.
   * @param {(live: Map<string, number>) => void} handler
   */
  onRounds(handler) {
    this.#onRounds = handler;
  }

  /** Lowest palette index no round in flight uses; if all are taken, the oldest round's, since it ends first. */
  #freeColor() {
    const used = new Set(this.#rounds.map((r) => r.color));
    for (let i = 0; i < ROUND_COLORS; i++) if (!used.has(i)) return i;
    return this.#rounds[0]?.color ?? 0;
  }

  #syncRounds() {
    const live = new Map(this.#rounds.map((r) => [r.id, r.color]));
    const key = [...live].join(";");
    if (key === this.#liveKey) return;
    this.#liveKey = key;
    this.#onRounds(live);
  }

  /** @param {string | null} account */
  highlight(account) {
    this.#highlighted = account;
    for (const g of this.svg.querySelectorAll("g.node")) {
      g.classList.toggle("is-highlighted", g.getAttribute("data-account") === account);
    }
  }

  #readColors() {
    const style = getComputedStyle(this.container);
    for (const name of ["ground", "land", "border", "grid", "mesh", "ink"]) {
      this.#colors[name] = style.getPropertyValue(`--map-${name}`).trim() || "#888";
    }
    this.#palette = Array.from({ length: ROUND_COLORS }, (_, i) => style.getPropertyValue(`--round-${i + 1}`).trim() || this.#colors.ink);
  }

  #projection() {
    const pad = Math.min(this.#width, this.#height) * 0.05;
    const projection = geoNaturalEarth1();
    if (this.#nodes.length === 0) {
      return projection.fitExtent([[pad, pad], [this.#width - pad, this.#height - pad]], { type: "Sphere" });
    }
    // Frame the operators, with breathing room, instead of the whole globe.
    const lons = this.#nodes.map((n) => n.lon);
    const lats = this.#nodes.map((n) => n.lat);
    const west = Math.max(-180, Math.min(...lons) - 6);
    const east = Math.min(180, Math.max(...lons) + 6);
    const south = Math.max(-80, Math.min(...lats) - 9);
    const north = Math.min(80, Math.max(...lats) + 4);
    projection.rotate([-(west + east) / 2, 0]);
    return projection.fitExtent([[pad, pad], [this.#width - pad, this.#height - pad]], {
      type: "MultiPoint",
      coordinates: [[west, south], [east, south], [west, north], [east, north], [(west + east) / 2, north], [(west + east) / 2, south]],
    });
  }

  #layout() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.#width = rect.width;
    this.#height = rect.height;
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.base, this.fx]) {
      canvas.width = Math.round(this.#width * this.#dpr);
      canvas.height = Math.round(this.#height * this.#dpr);
    }
    this.svg.setAttribute("viewBox", `0 0 ${this.#width} ${this.#height}`);
    this.#readColors();
    this.#sphere = geoPath(this.#projection()).bounds({ type: "Sphere" });
    this.#setView(this.#view.k, this.#view.x, this.#view.y);
    this.#render();
  }

  #queueRender() {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    requestAnimationFrame(() => {
      this.#renderQueued = false;
      this.#render();
    });
  }

  #render() {
    if (this.#width === 0 || this.#height === 0) return;
    const projection = this.#projection();

    // v1.signer has no location. Park it below the operators' center of mass,
    // over open water on the default framing; it then zooms with the map.
    const fitted = /** @type {[number, number][]} */ (this.#nodes.map((n) => projection([n.lon, n.lat])).filter(Boolean));
    const hub = fitted.length > 0
      ? {
        x: fitted.reduce((s, p) => s + p[0], 0) / fitted.length,
        y: Math.min(this.#height - 40, Math.max(...fitted.map((p) => p[1])) + this.#height * 0.16),
      }
      : { x: this.#width / 2, y: this.#height * 0.6 };

    const { k, x, y } = this.#view;
    const [tx, ty] = projection.translate();
    projection.scale(projection.scale() * k).translate([tx * k + x, ty * k + y]);
    this.#hub = { x: hub.x * k + x, y: hub.y * k + y };

    const projected = this.#nodes.flatMap((n) => {
      const p = projection([n.lon, n.lat]);
      return p ? [{ ...n, x: p[0], y: p[1] }] : [];
    });
    this.#nodes = spreadOverlapping(projected, MARKER_SPACING_PX);
    this.#byAccount = new Map(this.#nodes.map((n) => [n.account, n]));

    this.#drawBase(projection);
    this.#drawNodes();
    if (this.#frame === 0) this.#frame = requestAnimationFrame((t) => this.#draw(t));
  }

  // ── Zoom and pan ────────────────────────────────────────────────────────

  /**
   * Nearest view to (k, x, y) that keeps the zoom between the operators' frame
   * and MAX_ZOOM, and the globe covering the viewport — or centred, on an axis
   * where the globe is the smaller — so the map can be panned anywhere in the
   * world but not dragged off into the void.
   * @param {number} k
   * @param {number} x
   * @param {number} y
   */
  #constrain(k, x, y) {
    const [[left, top], [right, bottom]] = this.#sphere;
    k = clamp(k, 1, MAX_ZOOM);
    return { k, x: cover(x, left, right, k, this.#width), y: cover(y, top, bottom, k, this.#height) };
  }

  /**
   * @param {number} k
   * @param {number} x
   * @param {number} y
   */
  #setView(k, x, y) {
    const view = this.#constrain(k, x, y);
    const home = this.#constrain(1, 0, 0);
    const atHome = view.k === home.k && view.x === home.x && view.y === home.y;
    this.#view = view;
    this.container.classList.toggle("is-zoomed", !atHome);
    for (const button of this.controls.querySelectorAll("button")) {
      const zoom = button.getAttribute("data-zoom");
      button.disabled = zoom === "in" ? view.k >= MAX_ZOOM : zoom === "out" ? view.k <= 1 : atHome;
    }
    this.#queueRender();
  }

  /**
   * @param {number} factor
   * @param {number} px screen point that stays put
   * @param {number} py
   */
  #zoomAt(factor, px = this.#width / 2, py = this.#height / 2) {
    const { k, x, y } = this.#view;
    const next = clamp(k * factor, 1, MAX_ZOOM);
    this.#setView(next, px - (px - x) * (next / k), py - (py - y) * (next / k));
  }

  #showHint() {
    this.hint.classList.add("is-visible");
    clearTimeout(this.#hintTimer);
    this.#hintTimer = setTimeout(() => this.hint.classList.remove("is-visible"), 1400);
  }

  #bindGestures() {
    const el = this.container;
    /** @param {{ clientX: number, clientY: number }} e */
    const local = (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.controls.addEventListener("click", (e) => {
      const zoom = e.target instanceof Element ? e.target.closest("button")?.getAttribute("data-zoom") : null;
      if (zoom === "in") this.#zoomAt(2);
      else if (zoom === "out") this.#zoomAt(0.5);
      else if (zoom === "fit") this.#setView(1, 0, 0);
    });

    el.addEventListener("wheel", (e) => {
      // Where the page itself scrolls (narrow layouts), plain wheel keeps
      // scrolling it; Ctrl/⌘ or a trackpad pinch (which sets ctrlKey) zooms.
      const root = document.documentElement;
      if (root.scrollHeight > root.clientHeight && !e.ctrlKey && !e.metaKey) {
        this.#showHint();
        return;
      }
      e.preventDefault();
      const rate = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.002;
      const p = local(e);
      this.#zoomAt(2 ** (-e.deltaY * rate * (e.ctrlKey ? 10 : 1)), p.x, p.y);
    }, { passive: false });

    el.addEventListener("dblclick", (e) => {
      if (e.target instanceof Element && e.target.closest(".map-controls")) return;
      const p = local(e);
      this.#zoomAt(e.shiftKey ? 0.5 : 2, p.x, p.y);
    });

    // Drag to pan; two pointers pinch. One finger on an unzoomed map is left
    // to the browser (touch-action in CSS) so the page still scrolls.
    /** @type {Map<number, Point>} */
    const pointers = new Map();
    /** @type {(Point & { dist: number }) | null} */
    let last = null;
    const gesture = () => {
      const [a, b] = pointers.values();
      if (!a) return null;
      if (!b) return { ...a, dist: 0 };
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    /** @param {PointerEvent} e */
    const release = (e) => {
      if (!pointers.delete(e.pointerId)) return;
      last = gesture();
      if (pointers.size === 0) el.classList.remove("is-dragging");
    };

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".map-controls"))) return;
      pointers.set(e.pointerId, local(e));
      last = gesture();
      // Markers are rebuilt while dragging; keep the gesture on the container.
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e));
      const now = gesture();
      if (!now || !last) return;
      const { k, x, y } = this.#view;
      const next = now.dist > 0 && last.dist > 0 ? clamp(k * (now.dist / last.dist), 1, MAX_ZOOM) : k;
      if (next !== k || now.x !== last.x || now.y !== last.y) {
        el.classList.add("is-dragging");
        this.#setView(next, now.x - (last.x - x) * (next / k), now.y - (last.y - y) * (next / k));
      }
      last = now;
    });
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  /** @param {ReturnType<typeof geoNaturalEarth1>} projection */
  #drawBase(projection) {
    const ctx = this.base.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#width, this.#height);
    const path = geoPath(projection, ctx);

    ctx.beginPath();
    path(geoGraticule10());
    ctx.strokeStyle = this.#colors.grid;
    ctx.lineWidth = 0.5;
    ctx.stroke();

    if (this.#world) {
      // @ts-ignore topojson-client's generics don't survive JSDoc; shapes come from world-atlas.
      const land = feature(this.#world, this.#world.objects.land);
      ctx.beginPath();
      path(land);
      ctx.fillStyle = this.#colors.land;
      ctx.fill();
      // @ts-ignore same as above
      const borders = mesh(this.#world, this.#world.objects.countries, (a, b) => a !== b);
      ctx.beginPath();
      path(borders);
      ctx.strokeStyle = this.#colors.border;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // Every node holds a TLS connection to every other node.
    ctx.strokeStyle = this.#colors.mesh;
    ctx.lineWidth = 0.6;
    for (let i = 0; i < this.#nodes.length; i++) {
      for (let j = i + 1; j < this.#nodes.length; j++) {
        const at = curve(this.#nodes[i], this.#nodes[j], 0.12);
        ctx.beginPath();
        for (let s = 0; s <= 16; s++) {
          const p = at(s / 16);
          if (s === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
  }

  #drawNodes() {
    this.svg.replaceChildren();
    const hub = document.createElementNS(SVG_NS, "g");
    hub.classList.add("hub");
    hub.setAttribute("transform", `translate(${this.#hub.x} ${this.#hub.y})`);
    hub.innerHTML = `
      <polygon points="0,-13 11.3,-6.5 11.3,6.5 0,13 -11.3,6.5 -11.3,-6.5" />
      <text y="30" text-anchor="middle">v1.signer</text>
      <text class="sub" y="43" text-anchor="middle">on NEAR</text>`;
    this.svg.append(hub);

    const maxDelivered = Math.max(1, ...this.#nodes.map((n) => n.delivered));
    for (const node of this.#nodes) {
      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("node", `tee-${node.tee}`);
      g.classList.toggle("is-highlighted", node.account === this.#highlighted);
      g.setAttribute("data-account", node.account);
      g.setAttribute("tabindex", "0");
      g.setAttribute("transform", `translate(${node.x} ${node.y})`);
      g.setAttribute("aria-label", `${node.account}, ${node.label}`);
      const r = 4 + 4 * Math.sqrt(node.delivered / maxDelivered);

      if (Math.hypot(node.x - node.cx, node.y - node.cy) > 3) {
        const tether = document.createElementNS(SVG_NS, "line");
        tether.classList.add("tether");
        tether.setAttribute("x2", String(node.cx - node.x));
        tether.setAttribute("y2", String(node.cy - node.y));
        g.append(tether);
      }
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.classList.add("ring");
      ring.setAttribute("r", String(r + 3));
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.classList.add("dot");
      dot.setAttribute("r", String(r));
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${node.account}\n${node.label}`;
      g.append(ring, dot, title);

      const enter = () => this.#onHover(node.account);
      const leave = () => this.#onHover(null);
      g.addEventListener("pointerenter", enter);
      g.addEventListener("pointerleave", leave);
      g.addEventListener("focus", enter);
      g.addEventListener("blur", leave);
      g.addEventListener("click", () => this.#onSelect(node.account));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.#onSelect(node.account);
        }
      });
      this.svg.append(g);
    }
  }

  /** @param {number} now */
  #draw(now) {
    const ctx = this.fx.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#width, this.#height);
    this.#rounds = this.#rounds.filter((r) => now - r.startedAt < ROUND_MS);
    this.#syncRounds();
    /** @type {Map<string, number>} rounds already drawn on each leader this frame */
    const leading = new Map();
    for (const round of this.#rounds) {
      const rank = leading.get(round.leader) ?? 0;
      leading.set(round.leader, rank + 1);
      if (this.#reducedMotion.matches) this.#drawRoundStill(ctx, round, now - round.startedAt, rank);
      else this.#drawRound(ctx, round, now - round.startedAt, rank);
    }
    this.#frame = this.#rounds.length > 0 ? requestAnimationFrame((t) => this.#draw(t)) : 0;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Point} at
   * @param {number} radius
   * @param {string} color
   * @param {number} alpha
   */
  #ring(ctx, at, radius, color, alpha, width = 1.5) {
    ctx.globalAlpha = clamp01(alpha);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * A particle with a tapering tail travelling along `path`.
   * @param {CanvasRenderingContext2D} ctx
   * @param {(t: number) => Point} path
   * @param {number} t 0..1 head position
   * @param {string} color
   */
  #comet(ctx, path, t, color, size = 2.4, tail = 0.22, alpha = 1) {
    const steps = 10;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    for (let i = 0; i < steps; i++) {
      const t0 = t - tail * (1 - i / steps);
      const t1 = t - tail * (1 - (i + 1) / steps);
      if (t1 <= 0) continue;
      const a = path(Math.max(0, t0));
      const b = path(t1);
      ctx.globalAlpha = alpha * ((i + 1) / steps) * 0.8;
      ctx.lineWidth = size * ((i + 1) / steps);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const head = path(t);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(head.x, head.y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Round} round
   * @param {number} t ms since start
   * @param {number} rank how many earlier rounds in flight share this leader
   */
  #drawRound(ctx, round, t, rank) {
    const leader = this.#byAccount.get(round.leader);
    if (!leader) return;
    const color = this.#palette[round.color] ?? this.#colors.ink;
    const hub = this.#hub;

    // The leader is marked for the whole round, so the shares visibly converge on it.
    this.#leaderTag(ctx, leader, color, Math.min(t / 150, (ROUND_MS - t) / 400), rank);

    // Request lands on the contract.
    if (t < 900) {
      const p = t / 900;
      this.#ring(ctx, hub, 14 + 26 * p, color, 1 - p, 2);
    }

    // Every node observes the block.
    if (t > 150 && t < 1100) {
      const p = clamp01((t - 150) / 700);
      for (const node of this.#nodes) {
        this.#comet(ctx, curve(hub, node, 0.08), easeInOut(p), color, 1.2, 0.3, 0.45 * (1 - clamp01((t - 850) / 250)));
      }
    }

    // Peers stream shares into the leader.
    if (t > 900 && t < 2500) {
      round.peers.forEach((account, i) => {
        const peer = this.#byAccount.get(account);
        if (!peer) return;
        const stagger = ((i * 97) % 300);
        const p = clamp01((t - 900 - stagger) / 1000);
        if (p <= 0 || p >= 1) return;
        const path = curve(peer, leader, 0.18);
        ctx.globalAlpha = 0.25 * Math.sin(Math.PI * p);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let s = 0; s <= 20; s++) {
          const q = path(s / 20);
          if (s === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        this.#comet(ctx, path, easeInOut(p), color, 2.2, 0.25);
        if (p < 0.3) this.#ring(ctx, peer, 8 + 10 * (p / 0.3), color, 1 - p / 0.3, 1.2);
      });
    }

    // Leader submits respond().
    if (t > 2300 && t < 3100) {
      const p = clamp01((t - 2300) / 700);
      this.#comet(ctx, curve(leader, hub, -0.15), easeInOut(p), color, 3.2, 0.35);
    }

    // Signature is back on-chain; caption floats up from the contract.
    if (t > 2950) {
      const p = clamp01((t - 2950) / 650);
      this.#ring(ctx, hub, 16 + 34 * p, color, 1 - p, 2.5);
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle = color;
      ctx.font = "600 12px 'IBM Plex Mono', ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(round.caption, hub.x, hub.y - 24 - 18 * p);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Ring and "leader" tag on the node running the round, in the round's
   * color. A node leading several rounds at once gets them stacked outward.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Point} at
   * @param {string} color
   * @param {number} alpha
   * @param {number} rank
   */
  #leaderTag(ctx, at, color, alpha, rank) {
    alpha = clamp01(alpha);
    if (alpha === 0) return;
    this.#ring(ctx, at, 11 + 4 * rank, color, alpha, 2.5);
    const label = "leader";
    ctx.font = "600 10px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width + 10;
    const y = at.y - 24 - 18 * rank;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.#colors.ground;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(at.x - w / 2, y - 8, w, 16, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, at.x, y + 0.5);
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
  }

  /**
   * Reduced motion: no travel, just who took part, held briefly.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Round} round
   * @param {number} t
   * @param {number} rank
   */
  #drawRoundStill(ctx, round, t, rank) {
    const leader = this.#byAccount.get(round.leader);
    if (!leader) return;
    const color = this.#palette[round.color] ?? this.#colors.ink;
    const alpha = t < ROUND_MS - 600 ? 1 : (ROUND_MS - t) / 600;
    for (const account of round.peers) {
      const peer = this.#byAccount.get(account);
      if (peer) this.#ring(ctx, peer, 9, color, alpha, 1.2);
    }
    this.#leaderTag(ctx, leader, color, alpha, rank);
    this.#ring(ctx, this.#hub, 18, color, alpha, 2);
  }
}
