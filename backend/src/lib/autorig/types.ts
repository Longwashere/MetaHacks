// Shared shapes for auto-rigging: one image of a humanoid becomes a Spine 4.2 rig (see
// AUTO_RIG_PLAN.md at the repo root). Coordinates are image pixels of the cutout, x to the right
// and y down; the rig builder flips y for Spine.

/** "front" faces the viewer; "right" is turned toward the right of the image. */
export type AutoRigView = "front" | "right";

/**
 * The joints a rig is built from. `_l` / `_r` are the character's own left and right, so in a
 * front view `_r` is on the left of the image. `hand_*` is the fingertip end of the hand and
 * `toe_*` the tip of the foot.
 */
export const JOINT_NAMES = [
  "head",
  "neck",
  "pelvis",
  "shoulder_l",
  "elbow_l",
  "wrist_l",
  "hand_l",
  "shoulder_r",
  "elbow_r",
  "wrist_r",
  "hand_r",
  "hip_l",
  "knee_l",
  "ankle_l",
  "toe_l",
  "hip_r",
  "knee_r",
  "ankle_r",
  "toe_r",
] as const;

export type JointName = (typeof JOINT_NAMES)[number];

export interface Point {
  x: number;
  y: number;
}

export type Joints = Record<JointName, Point>;

/** A keyed-out character: straight (not premultiplied) RGBA, trimmed with a margin. */
export interface Cutout {
  width: number;
  height: number;
  rgba: Buffer;
}
