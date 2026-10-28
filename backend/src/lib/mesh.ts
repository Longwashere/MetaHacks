// Spine meshes trace their image's outline, and the runtime only draws the texture inside it, so a
// part repainted with a new shape (a mace where a sword was) is cut off at the old outline. Part
// fixes swap rigid meshes for a box over their whole atlas region so all of the new art shows.
// The math mirrors frontend/app/lib/spine-mesh.ts (the tweak panel's "Show the full texture").

export type MeshReason = "weighted" | "deformed" | "linked" | "distorted";

/** One mesh attachment that draws a region, and why it can't become a box (null when it can). */
export interface MeshCheck {
  region: string;
  slot: string;
  attachment: string;
  reason: MeshReason | null;
}

const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_TRIANGLES = [0, 1, 2, 2, 3, 0];
const QUAD_EDGES = [0, 2, 2, 4, 4, 6, 6, 0];
/** Largest gap between a point and the fitted mapping, as a share of the mesh's size, for it to count as undistorted. */
const MAX_FIT_ERROR = 0.02;

type Json = Record<string, unknown>;

/** The mesh attachments in a Spine 4.x skeleton JSON that draw any of `regions`. */
export function checkMeshes(skeleton: unknown, regions: string[]): MeshCheck[] {
  return meshEntries(skeleton, regions).map(({ check }) => check);
}

/** Swaps every rigid mesh that draws one of `regions` for a box over its region. Returns the regions boxed. */
export function boxMeshes(skeleton: unknown, regions: string[]): string[] {
  const boxed = new Set<string>();
  for (const { check, att } of meshEntries(skeleton, regions)) {
    if (check.reason) continue;
    const quad = quadFromMesh(att.uvs as number[], att.vertices as number[]);
    if (!quad) continue;
    att.uvs = [...QUAD_UVS];
    att.vertices = quad;
    att.triangles = [...QUAD_TRIANGLES];
    att.hull = 4;
    att.edges = [...QUAD_EDGES];
    boxed.add(check.region);
  }
  return [...boxed];
}

function meshEntries(skeleton: unknown, regions: string[]): { check: MeshCheck; att: Json }[] {
  if (!isObject(skeleton) || !Array.isArray(skeleton.skins)) return [];
  const wanted = new Set(regions);
  const animations = isObject(skeleton.animations) ? Object.values(skeleton.animations).filter(isObject) : [];
  const out: { check: MeshCheck; att: Json }[] = [];
  for (const skin of skeleton.skins.filter(isObject)) {
    const skinName = String(skin.name ?? "default");
    if (!isObject(skin.attachments)) continue;
    for (const [slot, atts] of Object.entries(skin.attachments)) {
      if (!isObject(atts)) continue;
      for (const [name, att] of Object.entries(atts)) {
        if (!isObject(att) || att.type !== "mesh") continue;
        const region = typeof att.path === "string" ? att.path : name;
        if (!wanted.has(region)) continue;
        const uvs = att.uvs, vertices = att.vertices;
        if (!isNumbers(uvs) || !isNumbers(vertices)) continue;
        const deformed = animations.some((a) => {
          const keys = isObject(a.attachments) ? dig(a.attachments, [skinName, slot, name, "deform"]) : undefined;
          return Array.isArray(keys) && keys.length > 0;
        });
        const linked = skeleton.skins.filter(isObject).some((s) => {
          const slotAtts = isObject(s.attachments) ? s.attachments[slot] : undefined;
          return isObject(slotAtts) && Object.values(slotAtts).some((a) => isObject(a) && a.type === "linkedmesh" && a.parent === name);
        });
        const reason: MeshReason | null =
          vertices.length !== uvs.length
            ? "weighted"
            : deformed
              ? "deformed"
              : linked
                ? "linked"
                : quadFromMesh(uvs, vertices)
                  ? null
                  : "distorted";
        out.push({ check: { region, slot, attachment: name, reason }, att });
      }
    }
  }
  return out;
}

/**
 * Bone-space positions of the region's four corners for an unweighted mesh, or null when its
 * points don't map from the image by a single stretch, turn and shift (an artist moved them).
 * Fits x = a·u + b·v + c and y = d·u + e·v + f by least squares.
 */
function quadFromMesh(uvs: number[], vertices: number[]): number[] | null {
  const n = uvs.length / 2;
  if (n < 3 || vertices.length !== uvs.length) return null;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rx = [0, 0, 0];
  const ry = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const row = [uvs[2 * i], uvs[2 * i + 1], 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[3 * r + c] += row[r] * row[c];
      rx[r] += row[r] * vertices[2 * i];
      ry[r] += row[r] * vertices[2 * i + 1];
    }
  }
  const fx = solve3(m, rx);
  const fy = solve3(m, ry);
  if (!fx || !fy) return null;
  const at = (u: number, v: number) => [fx[0] * u + fx[1] * v + fx[2], fy[0] * u + fy[1] * v + fy[2]];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, worst = 0;
  for (let i = 0; i < n; i++) {
    const x = vertices[2 * i], y = vertices[2 * i + 1];
    const [px, py] = at(uvs[2 * i], uvs[2 * i + 1]);
    worst = Math.max(worst, Math.hypot(px - x, py - y));
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const size = Math.hypot(maxX - minX, maxY - minY);
  if (!(size > 0) || worst > MAX_FIT_ERROR * size) return null;
  const quad: number[] = [];
  for (let i = 0; i < 4; i++) quad.push(...at(QUAD_UVS[2 * i], QUAD_UVS[2 * i + 1]).map((v) => Math.round(v * 100) / 100));
  return quad;
}

/** Solves the 3×3 system m·x = r by Cramer's rule, or null when it's singular (all points on a line). */
function solve3(m: number[], r: number[]): number[] | null {
  const det = (a: number[]) =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map((col) => {
    const a = [...m];
    for (let row = 0; row < 3; row++) a[3 * row + col] = r[row];
    return det(a) / d;
  });
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

function dig(value: Json, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}
