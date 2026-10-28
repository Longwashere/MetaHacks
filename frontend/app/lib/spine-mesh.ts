// Spine meshes trace their image's outline, and the runtime only draws the texture inside it. When
// a part is repainted with a new shape (a mace where a sword was), anything past the old outline
// is cut off. A rigid mesh can be swapped for a box covering its whole atlas region, so all of the
// new art shows. Used by the live preview (TweakController) and the bake; the backend has the same
// math in backend/src/lib/mesh.ts for part fixes. Keep them in step.

/** Why a part's mesh can't become a box, shown in the tweak panel. */
export const MESH_REASONS = {
  weighted: "It bends with several bones, so a box would stretch differently when it animates.",
  deformed: "An animation reshapes it, and those keys only fit its own outline.",
  linked: "It shares its mesh with other attachments.",
  distorted: "Its points were moved off the image, so a box wouldn't line up with it.",
} as const;
export type MeshReason = keyof typeof MESH_REASONS;

/** A box mesh over the whole region: corners in uv order (0,0) (1,0) (1,1) (0,1). */
export const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
export const QUAD_TRIANGLES = [0, 1, 2, 2, 3, 0];
/** Edges as vertex index pairs ×2, the way Spine JSON stores them. */
export const QUAD_EDGES = [0, 2, 2, 4, 4, 6, 6, 0];

/** Largest gap between a point and the fitted mapping, as a share of the mesh's size, for it to count as undistorted. */
const MAX_FIT_ERROR = 0.02;

/**
 * Bone-space positions of the region's four corners for an unweighted mesh, or null when its
 * points don't map from the image by a single stretch, turn and shift (an artist moved them).
 * Fits x = a·u + b·v + c and y = d·u + e·v + f by least squares.
 */
export function quadFromMesh(uvs: ArrayLike<number>, vertices: ArrayLike<number>): number[] | null {
  const n = uvs.length / 2;
  if (n < 3 || vertices.length !== uvs.length) return null;
  // Normal equations: M = Σ[u v 1]ᵀ[u v 1], and the right-hand sides for x and y.
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
  for (let i = 0; i < 4; i++) quad.push(...at(QUAD_UVS[2 * i], QUAD_UVS[2 * i + 1]).map(round));
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

function round(v: number) {
  return Math.round(v * 100) / 100;
}
