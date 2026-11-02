import type { AutoRigView, Cutout, Joints, Point } from "./types.js";

// Places joints from the character's silhouette. The pose step leaves the character upright with
// its arms held out and its legs apart, so the extremities are easy to find: the head is the top,
// the hands are the farthest points out on each side, the feet are the lowest points on each side
// and the crotch is the top of the gap between the legs. Elbows, knees and the rest follow from
// the arm and leg centrelines and typical proportions. The user corrects anything off by dragging.

/** Hand, forearm and upper arm as shares of the shoulder-to-fingertip length, from the fingertip. */
const HAND_SHARE = 0.2;
const FOREARM_SHARE = 0.37;

export function guessJoints(cut: Cutout, view: AutoRigView): Joints {
  const { width, height } = cut;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && cut.rgba[(y * width + x) * 4 + 3] >= 128;

  let [top, bottom] = [height, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const tall = bottom - top;
  const at = (share: number) => Math.round(top + tall * share);

  // Body centre: the middle of the solid run nearest the image centre, through the torso.
  const runsOf = (y: number) => {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && solid(x, y);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        runs.push([start, x - 1]);
        start = -1;
      }
    }
    return runs;
  };
  const runAt = (y: number, x: number) => {
    const runs = runsOf(y);
    return runs.find(([a, b]) => a <= x && x <= b) ?? runs.sort((p, q) => dist1(p, x) - dist1(q, x))[0] ?? null;
  };
  const torsoRows = [0.4, 0.45, 0.5].map((s) => runAt(at(s), width / 2)).filter((r): r is [number, number] => !!r);
  const cx = torsoRows.length ? median(torsoRows.map(([a, b]) => (a + b) / 2)) : width / 2;

  // Head: the highest solid pixel near the centre line (a plume off to one side doesn't count).
  let headY = top;
  const reach = tall * 0.08;
  find: for (let y = top; y <= bottom; y++) {
    for (let x = Math.round(cx - reach); x <= cx + reach; x++) {
      if (solid(x, y)) {
        headY = y;
        break find;
      }
    }
  }

  // Crotch: follow the gap between the legs up from near the feet until it closes.
  let gapX = cx;
  let crotchY = at(0.55);
  {
    const y0 = at(0.9);
    const runs = runsOf(y0).filter(([a, b]) => b - a > tall * 0.01);
    const left = runs.filter(([, b]) => b < cx).pop();
    const right = runs.find(([a]) => a > cx);
    if (left && right) {
      gapX = (left[1] + right[0]) / 2;
      let y = y0;
      for (; y > at(0.3); y--) {
        if (solid(Math.round(gapX), y)) break;
        // Re-centre in the gap on this row so a slanted gap is followed.
        let [a, b] = [Math.round(gapX), Math.round(gapX)];
        while (a > 0 && !solid(a - 1, y)) a--;
        while (b < width - 1 && !solid(b + 1, y)) b++;
        gapX = (a + b) / 2;
      }
      crotchY = y + 1;
    }
  }

  // Legs: each side of the gap below the crotch.
  const leg = (side: -1 | 1) => {
    const inLeg = (x: number) => (side < 0 ? x < gapX : x > gapX);
    let footY = crotchY;
    for (let y = crotchY; y <= bottom; y++) {
      for (let x = 0; x < width; x++) if (inLeg(x) && solid(x, y)) footY = y;
    }
    const centreAt = (y: number, fallback: number) => {
      const runs = runsOf(y).filter(([a, b]) => inLeg((a + b) / 2));
      if (!runs.length) return fallback;
      const run = runs.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))[0];
      return (run[0] + run[1]) / 2;
    };
    const legX = centreAt(Math.round(crotchY + tall * 0.04), gapX + side * tall * 0.06);
    const hipY = crotchY - tall * 0.04;
    const ankleY = footY - tall * 0.055;
    const ankleX = centreAt(Math.round(ankleY), legX);
    const kneeY = (hipY + ankleY) / 2;
    const kneeX = centreAt(Math.round(kneeY), (legX + ankleX) / 2);
    // Toe: the lowest point in front for a turned view, the middle of the sole for a front view.
    let toe: Point = { x: ankleX, y: footY };
    if (view === "right") {
      for (let y = Math.round(footY - tall * 0.05); y <= footY; y++) {
        for (let x = 0; x < width; x++) if (inLeg(x) && solid(x, y) && x > toe.x) toe = { x, y };
      }
    } else {
      toe = { x: centreAt(footY, ankleX), y: footY };
    }
    return { hip: { x: legX, y: hipY }, knee: { x: kneeX, y: kneeY }, ankle: { x: ankleX, y: ankleY }, toe };
  };
  // In both views the character's right side is on the left of the image.
  const legR = leg(-1);
  const legL = leg(1);

  // Arms: from each fingertip (the farthest solid pixel out on that side, above the feet), follow
  // the arm's centreline inward until it widens into the torso.
  const arm = (side: -1 | 1) => {
    let tip: Point = { x: cx, y: at(0.4) };
    for (let y = at(0.1); y <= at(0.8); y++) {
      for (let x = 0; x < width; x++) {
        if (!solid(x, y)) continue;
        if ((x - cx) * side > (tip.x - cx) * side) tip = { x, y };
      }
    }
    // The arm's centreline and its top and bottom edge, column by column toward the body.
    const line: (Point & { bottom: number; width: number })[] = [];
    let y = tip.y;
    for (let x = tip.x; (x - cx) * side > tall * 0.04; x -= side) {
      const col: [number, number][] = [];
      let start = -1;
      for (let yy = at(0.05); yy <= at(0.85) + 1; yy++) {
        const on = solid(x, yy);
        if (on && start < 0) start = yy;
        if (!on && start >= 0) {
          col.push([start, yy - 1]);
          start = -1;
        }
      }
      // Stay on the arm: a nearby run only, never a jump to a plume or cape.
      const run = col.find(([a, b]) => a <= y && y <= b) ?? col.filter((r) => dist1(r, y) <= Math.max(4, tall * 0.05)).sort((p, q) => dist1(p, y) - dist1(q, y))[0];
      if (!run) break;
      const w = run[1] - run[0];
      y = (run[0] + run[1]) / 2;
      line.push({ x, y, bottom: run[1], width: w });
    }
    const outer = line.slice(0, Math.max(1, Math.floor(line.length * 0.4)));
    const dir = norm({ x: tip.x - (outer[outer.length - 1]?.x ?? cx), y: tip.y - (outer[outer.length - 1]?.y ?? tip.y) });
    // Thickness across the arm, from its vertical extent and slope.
    const thick = (outer.length ? median(outer.map((p) => p.width)) : tall * 0.05) * Math.max(Math.abs(dir.x), 0.3);

    // Armpit: the top of the open space under the arm, beside the torso. Flood it from just
    // under the arm and take its highest point, leaning inward.
    let shoulder: Point | null = null;
    const seed = outer[outer.length - 1];
    if (seed) {
      const xa = Math.min(cx + side * tall * 0.03, seed.x);
      const xb = Math.max(cx + side * tall * 0.03, seed.x);
      const ya = at(0.05);
      const seen = new Set<number>();
      const stack: Point[] = [];
      for (let yy = Math.round(seed.bottom) + 1; yy < crotchY; yy++) {
        if (!solid(seed.x, yy)) {
          stack.push({ x: seed.x, y: yy });
          break;
        }
      }
      let best: Point | null = null;
      let bestScore = Infinity;
      while (stack.length) {
        const p = stack.pop()!;
        const key = p.y * width + p.x;
        if (p.x < xa || p.x > xb || p.y < ya || p.y >= crotchY || seen.has(key) || solid(p.x, p.y)) continue;
        seen.add(key);
        const score = p.y + 0.3 * Math.abs(p.x - cx);
        if (score < bestScore) [best, bestScore] = [p, score];
        stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
      }
      if (best) {
        // The joint sits half the arm's thickness above the armpit, a little inward.
        const up = side > 0 ? { x: dir.y, y: -dir.x } : { x: -dir.y, y: dir.x };
        shoulder = { x: best.x + up.x * thick * 0.5 - dir.x * thick * 0.35, y: best.y + up.y * thick * 0.5 - dir.y * thick * 0.35 };
      }
    }
    // A shoulder off the arm's line (the flood escaped into the space by a plume or cape) falls
    // back to where the arm widens into the torso.
    const offLine = (p: Point) => Math.abs((p.x - tip.x) * dir.y - (p.y - tip.y) * dir.x);
    if (!shoulder || offLine(shoulder) > Math.hypot(tip.x - shoulder.x, tip.y - shoulder.y) * 0.25) {
      const armWidth = outer.length ? median(outer.map((p) => p.width)) : 0;
      const end = line.find((p, i) => i > outer.length && p.width > armWidth * 2) ?? line[line.length - 1] ?? tip;
      shoulder = { x: end.x - dir.x * thick * 0.5, y: end.y - dir.y * thick * 0.5 };
    }
    // Elbow and wrist at their usual shares of the arm, measured along its centreline.
    const s = shoulder;
    const path = [s, ...line.filter((p) => (p.x - s.x) * side > 0).reverse(), tip];
    const elbow = along(path, 1 - HAND_SHARE - FOREARM_SHARE);
    const wrist = along(path, 1 - HAND_SHARE);
    return { shoulder, elbow, wrist, hand: tip };
  };
  const armR = arm(-1);
  const armL = arm(1);

  // Neck: the narrowest row in the lower part of the span between the head top and the shoulders.
  const shoulderY = (armL.shoulder.y + armR.shoulder.y) / 2;
  const span = Math.max(shoulderY - headY, 1);
  let neck: Point = { x: cx, y: shoulderY - span * 0.15 };
  let narrowest = Infinity;
  for (let y = Math.round(headY + span * 0.45); y < shoulderY - span * 0.05; y++) {
    const run = runAt(y, cx);
    if (!run) continue;
    const w = run[1] - run[0];
    if (w < narrowest) {
      narrowest = w;
      neck = { x: (run[0] + run[1]) / 2, y };
    }
  }

  return {
    head: { x: neck.x, y: headY },
    neck,
    pelvis: { x: (legL.hip.x + legR.hip.x) / 2, y: (legL.hip.y + legR.hip.y) / 2 },
    shoulder_l: armL.shoulder,
    elbow_l: armL.elbow,
    wrist_l: armL.wrist,
    hand_l: armL.hand,
    shoulder_r: armR.shoulder,
    elbow_r: armR.elbow,
    wrist_r: armR.wrist,
    hand_r: armR.hand,
    hip_l: legL.hip,
    knee_l: legL.knee,
    ankle_l: legL.ankle,
    toe_l: legL.toe,
    hip_r: legR.hip,
    knee_r: legR.knee,
    ankle_r: legR.ankle,
    toe_r: legR.toe,
  };
}

/** The point a share of the way along a polyline, by length. */
function along(path: Point[], share: number): Point {
  const lens = path.slice(1).map((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y));
  let left = lens.reduce((a, b) => a + b, 0) * share;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? Math.min(left / lens[i], 1) : 0;
      return { x: path[i].x + (path[i + 1].x - path[i].x) * t, y: path[i].y + (path[i + 1].y - path[i].y) * t };
    }
    left -= lens[i];
  }
  return path[path.length - 1];
}

function norm(p: Point): Point {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
}

function dist1([a, b]: [number, number], v: number): number {
  return v < a ? a - v : v > b ? v - b : 0;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
