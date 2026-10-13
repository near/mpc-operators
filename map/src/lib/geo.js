// @ts-check

/**
 * Hostname of a participant URL. The contract stores whatever the operator
 * registered, so this has to cope with bare IPs and odd ports.
 * @param {string} url
 * @returns {string | null}
 */
export function hostOf(url) {
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** @param {string} host */
export function isIPv4(host) {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Most operators sit in a handful of Western European data centers (three in
 * Westland, NL alone). Push markers that would overlap apart, just enough, while
 * a weak spring pulls each back toward its true spot:
 *
 *        before            after       (· = true spot, tethered when moved)
 *
 *         (ooo)    ──▶    o ·  o
 *          oo              o· ·o
 *                            o
 *
 * Deterministic: same input, same layout.
 *
 * @template {{ x: number, y: number }} T
 * @param {T[]} points
 * @param {number} minDistance pixels between marker centers
 * @returns {(T & { x: number, y: number, cx: number, cy: number })[]} copies with adjusted x/y; cx/cy is the true spot
 */
export function spreadOverlapping(points, minDistance) {
  const out = points.map((p) => ({ ...p, cx: p.x, cy: p.y }));
  const ITERATIONS = 300;
  const SPRING = 0.02;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= minDistance) continue;
        // Identical spots have no direction; split them along a fixed per-pair angle.
        const angle = ((i * 7 + j * 13) % 16) * (Math.PI / 8);
        const ux = d < 1e-6 ? Math.cos(angle) : dx / d;
        const uy = d < 1e-6 ? Math.sin(angle) : dy / d;
        const push = (minDistance - d) / 2;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    // The spring stops in the final iterations so separation wins.
    if (iter < ITERATIONS - 50) {
      for (const p of out) {
        p.x += (p.cx - p.x) * SPRING;
        p.y += (p.cy - p.y) * SPRING;
      }
    } else if (!moved) {
      break;
    }
  }
  return out;
}
