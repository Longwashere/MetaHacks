// COPY of frontend/app/lib/spine-skel-json.ts, kept identical below this header. The backend uses
// it to fingerprint stored .skel rigs (lib/fingerprint.ts): the upload page converts .skel files
// with the same code, so the rig hashes only match while the two copies produce the same JSON.
// Change both together.
//
// Converts a Spine 4.2 binary skeleton (.skel) into Spine JSON, so binary rigs can be tweaked
// and saved like JSON ones (the bake in spine-tweak-bake only edits JSON). It reads the file
// the way the runtime's SkeletonBinary does, field for field, and writes the keys SkeletonJson
// reads. Nothing is lost that a runtime uses: bezier curves keep their control points, which the
// runtime's loaded data no longer has. Values equal to SkeletonJson's defaults are left out.
//
// Mirrors @esotericsoftware/spine-core 4.2 (SkeletonBinary.js / SkeletonJson.js); keep in step
// when the runtime is upgraded.

type Json = Record<string, unknown>;

const ATTACHMENT_TYPES = ["region", "boundingbox", "mesh", "linkedmesh", "path", "point", "clipping"] as const;
const BLEND_MODES = ["normal", "additive", "multiply", "screen"];
const INHERITS = ["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"];
const POSITION_MODES = ["fixed", "percent"];
const SPACING_MODES = ["length", "fixed", "percent", "proportional"];
const ROTATE_MODES = ["tangent", "chain", "chainScale"];
const SEQUENCE_MODES = ["hold", "once", "loop", "pingpong", "onceReverse", "loopReverse", "pingpongReverse"];
const BONE_TIMELINES = ["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "shear", "shearx", "sheary", "inherit"];
const PHYSICS_TIMELINES: Record<number, string> = { 0: "inertia", 1: "strength", 2: "damping", 4: "mass", 5: "wind", 6: "gravity", 7: "mix", 8: "reset" };

const CURVE_STEPPED = 1;
const CURVE_BEZIER = 2;

/** Converts a Spine 4.2 .skel file to the equivalent skeleton JSON. Throws on other versions or a malformed file. */
export function skelToJson(data: ArrayBuffer | Uint8Array): Json {
  const input = new BinaryInput(data);
  const lowHash = input.readInt32();
  const highHash = input.readInt32();
  const version = input.readString();
  if (!version?.startsWith("4.2")) {
    throw new Error(`Only Spine 4.2 binary skeletons can be converted; this one is ${version ? `Spine ${version}` : "not a Spine binary file"}.`);
  }

  const skeleton: Json = {};
  // Same hash string as the runtime makes from the file.
  if (lowHash !== 0 || highHash !== 0) skeleton.hash = highHash.toString(16) + lowHash.toString(16);
  skeleton.spine = version;
  skeleton.x = input.readFloat();
  skeleton.y = input.readFloat();
  skeleton.width = input.readFloat();
  skeleton.height = input.readFloat();
  set(skeleton, "referenceScale", input.readFloat(), 100);
  const nonessential = input.readBoolean();
  if (nonessential) {
    skeleton.fps = input.readFloat();
    set(skeleton, "images", input.readString(), null);
    set(skeleton, "audio", input.readString(), null);
  }
  const root: Json = { skeleton };

  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const s = input.readString();
    if (!s) throw new Error("String in string table must not be null.");
    input.strings.push(s);
  }

  // Bones.
  const bones: string[] = [];
  const boneMaps: Json[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Bone name");
    const bone: Json = { name };
    if (i > 0) bone.parent = bones[input.readInt(true)];
    set(bone, "rotation", input.readFloat(), 0);
    set(bone, "x", input.readFloat(), 0);
    set(bone, "y", input.readFloat(), 0);
    set(bone, "scaleX", input.readFloat(), 1);
    set(bone, "scaleY", input.readFloat(), 1);
    set(bone, "shearX", input.readFloat(), 0);
    set(bone, "shearY", input.readFloat(), 0);
    set(bone, "length", input.readFloat(), 0);
    set(bone, "inherit", INHERITS[input.readByte()], "normal");
    set(bone, "skin", input.readBoolean(), false);
    if (nonessential) {
      bone.color = rgba8888(input.readInt32());
      set(bone, "icon", input.readString(), null);
      set(bone, "visible", input.readBoolean(), true);
    }
    bones.push(name);
    boneMaps.push(bone);
  }
  root.bones = boneMaps;

  // Slots.
  const slots: string[] = [];
  const slotMaps: Json[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Slot name");
    const slot: Json = { name, bone: bones[input.readInt(true)] };
    set(slot, "color", rgba8888(input.readInt32()), "ffffffff");
    const dark = input.readInt32();
    if (dark !== -1) slot.dark = rgb888(dark);
    set(slot, "attachment", input.readStringRef(), null);
    set(slot, "blend", BLEND_MODES[input.readInt(true)], "normal");
    if (nonessential) set(slot, "visible", input.readBoolean(), true);
    slots.push(name);
    slotMaps.push(slot);
  }
  if (slotMaps.length > 0) root.slots = slotMaps;

  // IK constraints. Fields the file leaves out keep the runtime's class defaults (mix 0).
  const iks: string[] = [];
  const ikMaps: Json[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "IK constraint name");
    const ik: Json = { name };
    set(ik, "order", input.readInt(true), 0);
    ik.bones = readNames(input, bones);
    ik.target = bones[input.readInt(true)];
    const flags = input.readByte();
    set(ik, "skin", (flags & 1) !== 0, false);
    set(ik, "bendPositive", (flags & 2) !== 0, true);
    set(ik, "compress", (flags & 4) !== 0, false);
    set(ik, "stretch", (flags & 8) !== 0, false);
    set(ik, "uniform", (flags & 16) !== 0, false);
    set(ik, "mix", (flags & 32) !== 0 ? ((flags & 64) !== 0 ? input.readFloat() : 1) : 0, 1);
    if ((flags & 128) !== 0) set(ik, "softness", input.readFloat(), 0);
    iks.push(name);
    ikMaps.push(ik);
  }
  if (ikMaps.length > 0) root.ik = ikMaps;

  // Transform constraints. Unflagged values are 0 in the runtime, but SkeletonJson defaults mixes to 1.
  const transforms: string[] = [];
  const transformMaps: Json[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Transform constraint name");
    const tc: Json = { name };
    set(tc, "order", input.readInt(true), 0);
    tc.bones = readNames(input, bones);
    tc.target = bones[input.readInt(true)];
    let flags = input.readByte();
    set(tc, "skin", (flags & 1) !== 0, false);
    set(tc, "local", (flags & 2) !== 0, false);
    set(tc, "relative", (flags & 4) !== 0, false);
    set(tc, "rotation", (flags & 8) !== 0 ? input.readFloat() : 0, 0);
    set(tc, "x", (flags & 16) !== 0 ? input.readFloat() : 0, 0);
    set(tc, "y", (flags & 32) !== 0 ? input.readFloat() : 0, 0);
    set(tc, "scaleX", (flags & 64) !== 0 ? input.readFloat() : 0, 0);
    set(tc, "scaleY", (flags & 128) !== 0 ? input.readFloat() : 0, 0);
    flags = input.readByte();
    set(tc, "shearY", (flags & 1) !== 0 ? input.readFloat() : 0, 0);
    const mixRotate = (flags & 2) !== 0 ? input.readFloat() : 0;
    const mixX = (flags & 4) !== 0 ? input.readFloat() : 0;
    const mixY = (flags & 8) !== 0 ? input.readFloat() : 0;
    const mixScaleX = (flags & 16) !== 0 ? input.readFloat() : 0;
    const mixScaleY = (flags & 32) !== 0 ? input.readFloat() : 0;
    const mixShearY = (flags & 64) !== 0 ? input.readFloat() : 0;
    set(tc, "mixRotate", mixRotate, 1);
    set(tc, "mixX", mixX, 1);
    set(tc, "mixY", mixY, mixX);
    set(tc, "mixScaleX", mixScaleX, 1);
    set(tc, "mixScaleY", mixScaleY, mixScaleX);
    set(tc, "mixShearY", mixShearY, 1);
    transforms.push(name);
    transformMaps.push(tc);
  }
  if (transformMaps.length > 0) root.transform = transformMaps;

  // Path constraints.
  const paths: string[] = [];
  const pathMaps: Json[] = [];
  const pathModes: { position: string; spacing: string }[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Path constraint name");
    const pc: Json = { name };
    set(pc, "order", input.readInt(true), 0);
    set(pc, "skin", input.readBoolean(), false);
    pc.bones = readNames(input, bones);
    pc.target = slots[input.readInt(true)];
    const flags = input.readByte();
    const position = POSITION_MODES[flags & 1];
    const spacing = SPACING_MODES[(flags >> 1) & 3];
    set(pc, "positionMode", position, "percent");
    set(pc, "spacingMode", spacing, "length");
    set(pc, "rotateMode", ROTATE_MODES[(flags >> 3) & 3], "tangent");
    if ((flags & 128) !== 0) set(pc, "rotation", input.readFloat(), 0);
    set(pc, "position", input.readFloat(), 0);
    set(pc, "spacing", input.readFloat(), 0);
    set(pc, "mixRotate", input.readFloat(), 1);
    const mixX = input.readFloat();
    set(pc, "mixX", mixX, 1);
    set(pc, "mixY", input.readFloat(), mixX);
    paths.push(name);
    pathMaps.push(pc);
    pathModes.push({ position, spacing });
  }
  if (pathMaps.length > 0) root.path = pathMaps;

  // Physics constraints.
  const physics: string[] = [];
  const physicsMaps: Json[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Physics constraint name");
    const pc: Json = { name };
    set(pc, "order", input.readInt(true), 0);
    pc.bone = bones[input.readInt(true)];
    let flags = input.readByte();
    set(pc, "skin", (flags & 1) !== 0, false);
    set(pc, "x", (flags & 2) !== 0 ? input.readFloat() : 0, 0);
    set(pc, "y", (flags & 4) !== 0 ? input.readFloat() : 0, 0);
    set(pc, "rotate", (flags & 8) !== 0 ? input.readFloat() : 0, 0);
    set(pc, "scaleX", (flags & 16) !== 0 ? input.readFloat() : 0, 0);
    set(pc, "shearX", (flags & 32) !== 0 ? input.readFloat() : 0, 0);
    set(pc, "limit", (flags & 64) !== 0 ? input.readFloat() : 5000, 5000);
    // The file stores steps per second; the runtime keeps 1 / fps.
    set(pc, "fps", input.readUnsignedByte(), 60);
    set(pc, "inertia", input.readFloat(), 1);
    set(pc, "strength", input.readFloat(), 100);
    set(pc, "damping", input.readFloat(), 1);
    // The file stores the inverse mass; JSON stores the mass.
    set(pc, "mass", (flags & 128) !== 0 ? 1 / input.readFloat() : 1, 1);
    set(pc, "wind", input.readFloat(), 0);
    set(pc, "gravity", input.readFloat(), 0);
    flags = input.readByte();
    set(pc, "inertiaGlobal", (flags & 1) !== 0, false);
    set(pc, "strengthGlobal", (flags & 2) !== 0, false);
    set(pc, "dampingGlobal", (flags & 4) !== 0, false);
    set(pc, "massGlobal", (flags & 8) !== 0, false);
    set(pc, "windGlobal", (flags & 16) !== 0, false);
    set(pc, "gravityGlobal", (flags & 32) !== 0, false);
    set(pc, "mixGlobal", (flags & 64) !== 0, false);
    set(pc, "mix", (flags & 128) !== 0 ? input.readFloat() : 1, 1);
    physics.push(name);
    physicsMaps.push(pc);
  }
  if (physicsMaps.length > 0) root.physics = physicsMaps;

  // Skins: the default skin first (when it has attachments), then the named ones.
  const ctx: Context = { input, nonessential, bones, slots, skins: [] };
  const skinMaps: Json[] = [];
  const defaultSkin = readSkin(ctx, true, { iks, transforms, paths, physics });
  if (defaultSkin) skinMaps.push(defaultSkin);
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const skin = readSkin(ctx, false, { iks, transforms, paths, physics });
    if (skin) skinMaps.push(skin);
  }
  ctx.skins = skinMaps.map((s) => s.name as string);
  // Linked meshes name their parent's skin by index; JSON uses the name, or nothing for the default skin.
  for (const { map, skinIndex } of ctx.linkedMeshes ?? []) {
    const skin = ctx.skins[skinIndex];
    if (skin === undefined) throw new Error(`Linked mesh skin not found: ${skinIndex}`);
    if (skin !== "default") map.skin = skin;
  }
  if (skinMaps.length > 0) root.skins = skinMaps;

  // Events.
  const events: { name: string; audio: boolean }[] = [];
  const eventMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Event name");
    const event: Json = {};
    set(event, "int", input.readInt(false), 0);
    set(event, "float", input.readFloat(), 0);
    set(event, "string", input.readString(), null);
    const audio = input.readString();
    if (audio) {
      event.audio = audio;
      set(event, "volume", input.readFloat(), 1);
      set(event, "balance", input.readFloat(), 0);
    }
    events.push({ name, audio: !!audio });
    eventMaps[name] = event;
  }
  if (events.length > 0) root.events = eventMaps;

  // Animations.
  const animations: Json = {};
  const names = { bones, slots, iks, transforms, paths, pathModes, physics, events, skins: ctx.skins };
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = required(input.readString(), "Animation name");
    animations[name] = readAnimation(input, names);
  }
  if (Object.keys(animations).length > 0) root.animations = animations;

  if (input.index !== input.length) throw new Error("The .skel file has unread data; it may not be a Spine 4.2 file.");
  return root;
}

interface Context {
  input: BinaryInput;
  nonessential: boolean;
  bones: string[];
  slots: string[];
  skins: string[];
  linkedMeshes?: { map: Json; skinIndex: number }[];
}

function readSkin(
  ctx: Context,
  isDefault: boolean,
  constraints: { iks: string[]; transforms: string[]; paths: string[]; physics: string[] },
): Json | null {
  const { input } = ctx;
  let skin: Json;
  let slotCount: number;
  if (isDefault) {
    slotCount = input.readInt(true);
    if (slotCount === 0) return null;
    skin = { name: "default" };
  } else {
    skin = { name: required(input.readString(), "Skin name") };
    if (ctx.nonessential) skin.color = rgba8888(input.readInt32());
    const lists: [string, string[]][] = [
      ["bones", ctx.bones],
      ["ik", constraints.iks],
      ["transform", constraints.transforms],
      ["path", constraints.paths],
      ["physics", constraints.physics],
    ];
    for (const [key, names] of lists) {
      const list = readNames(input, names);
      if (list.length > 0) skin[key] = list;
    }
    slotCount = input.readInt(true);
  }
  const attachments: Json = {};
  for (let i = 0; i < slotCount; i++) {
    const slot = ctx.slots[input.readInt(true)];
    const entries: Json = (attachments[slot] as Json | undefined) ?? {};
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const name = required(input.readStringRef(), "Attachment name");
      entries[name] = readAttachment(ctx, name);
    }
    attachments[slot] = entries;
  }
  skin.attachments = attachments;
  return skin;
}

function readAttachment(ctx: Context, key: string): Json {
  const { input, nonessential } = ctx;
  const flags = input.readByte();
  const att: Json = {};
  const type = ATTACHMENT_TYPES[flags & 0b111];
  if (!type) throw new Error(`Unknown attachment type ${flags & 0b111}.`);
  if (type !== "region") att.type = type;
  const name = (flags & 8) !== 0 ? required(input.readStringRef(), "Attachment name") : key;
  if (name !== key) att.name = name;

  switch (type) {
    case "region": {
      const path = (flags & 16) !== 0 ? input.readStringRef() : null;
      if (path && path !== name) att.path = path;
      if ((flags & 32) !== 0) set(att, "color", rgba8888(input.readInt32()), "ffffffff");
      if ((flags & 64) !== 0) att.sequence = readSequence(input);
      set(att, "rotation", (flags & 128) !== 0 ? input.readFloat() : 0, 0);
      set(att, "x", input.readFloat(), 0);
      set(att, "y", input.readFloat(), 0);
      set(att, "scaleX", input.readFloat(), 1);
      set(att, "scaleY", input.readFloat(), 1);
      att.width = input.readFloat();
      att.height = input.readFloat();
      return att;
    }
    case "boundingbox": {
      const { count, vertices } = readVertices(input, (flags & 16) !== 0);
      att.vertexCount = count;
      att.vertices = vertices;
      if (nonessential) att.color = rgba8888(input.readInt32());
      return att;
    }
    case "mesh": {
      const path = (flags & 16) !== 0 ? input.readStringRef() : null;
      if (path && path !== name) att.path = path;
      if ((flags & 32) !== 0) set(att, "color", rgba8888(input.readInt32()), "ffffffff");
      if ((flags & 64) !== 0) att.sequence = readSequence(input);
      const hull = input.readInt(true);
      const { count, vertices } = readVertices(input, (flags & 128) !== 0);
      att.uvs = readFloats(input, count * 2);
      att.triangles = readShorts(input, (count * 2 - hull - 2) * 3);
      att.vertices = vertices;
      att.hull = hull;
      if (nonessential) {
        att.edges = readShorts(input, input.readInt(true));
        att.width = input.readFloat();
        att.height = input.readFloat();
      }
      return att;
    }
    case "linkedmesh": {
      const path = (flags & 16) !== 0 ? input.readStringRef() : null;
      if (path && path !== name) att.path = path;
      if ((flags & 32) !== 0) set(att, "color", rgba8888(input.readInt32()), "ffffffff");
      if ((flags & 64) !== 0) att.sequence = readSequence(input);
      set(att, "timelines", (flags & 128) !== 0, true);
      const skinIndex = input.readInt(true);
      att.parent = required(input.readStringRef(), "Linked mesh parent");
      if (nonessential) {
        att.width = input.readFloat();
        att.height = input.readFloat();
      }
      (ctx.linkedMeshes ??= []).push({ map: att, skinIndex });
      return att;
    }
    case "path": {
      set(att, "closed", (flags & 16) !== 0, false);
      set(att, "constantSpeed", (flags & 32) !== 0, true);
      const { count, vertices } = readVertices(input, (flags & 64) !== 0);
      att.vertexCount = count;
      att.vertices = vertices;
      att.lengths = readFloats(input, count / 3);
      if (nonessential) att.color = rgba8888(input.readInt32());
      return att;
    }
    case "point": {
      set(att, "rotation", input.readFloat(), 0);
      set(att, "x", input.readFloat(), 0);
      set(att, "y", input.readFloat(), 0);
      if (nonessential) att.color = rgba8888(input.readInt32());
      return att;
    }
    case "clipping": {
      att.end = ctx.slots[input.readInt(true)];
      const { count, vertices } = readVertices(input, (flags & 16) !== 0);
      att.vertexCount = count;
      att.vertices = vertices;
      if (nonessential) att.color = rgba8888(input.readInt32());
      return att;
    }
  }
}

function readSequence(input: BinaryInput): Json {
  return { count: input.readInt(true), start: input.readInt(true), digits: input.readInt(true), setup: input.readInt(true) };
}

/** Vertex positions; weighted ones as JSON stores them: per vertex, a bone count then (bone, x, y, weight) per bone. */
function readVertices(input: BinaryInput, weighted: boolean): { count: number; vertices: number[] } {
  const count = input.readInt(true);
  if (!weighted) return { count, vertices: readFloats(input, count * 2) };
  const vertices: number[] = [];
  for (let i = 0; i < count; i++) {
    const bones = input.readInt(true);
    vertices.push(bones);
    for (let ii = 0; ii < bones; ii++) vertices.push(input.readInt(true), input.readFloat(), input.readFloat(), input.readFloat());
  }
  return { count, vertices };
}

interface Names {
  bones: string[];
  slots: string[];
  iks: string[];
  transforms: string[];
  paths: string[];
  pathModes: { position: string; spacing: string }[];
  physics: string[];
  events: { name: string; audio: boolean }[];
  skins: string[];
}

function readAnimation(input: BinaryInput, names: Names): Json {
  input.readInt(true); // Number of timelines.
  const animation: Json = {};

  // Slot timelines.
  const slotMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const slot: Json = {};
    slotMaps[names.slots[input.readInt(true)]] = slot;
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const type = input.readByte();
      const frameCount = input.readInt(true);
      switch (type) {
        case 0: {
          const keys: Json[] = [];
          for (let frame = 0; frame < frameCount; frame++) {
            const key = timeKey(input);
            set(key, "name", input.readStringRef(), null);
            keys.push(key);
          }
          slot.attachment = keys;
          break;
        }
        case 1:
          input.readInt(true); // Bezier count.
          slot.rgba = readKeys(input, frameCount, 4, (key) => (key.color = colorBytes(input, 4)));
          break;
        case 2:
          input.readInt(true);
          slot.rgb = readKeys(input, frameCount, 3, (key) => (key.color = colorBytes(input, 3)));
          break;
        case 3:
          input.readInt(true);
          slot.rgba2 = readKeys(input, frameCount, 7, (key) => {
            key.light = colorBytes(input, 4);
            key.dark = colorBytes(input, 3);
          });
          break;
        case 4:
          input.readInt(true);
          slot.rgb2 = readKeys(input, frameCount, 6, (key) => {
            key.light = colorBytes(input, 3);
            key.dark = colorBytes(input, 3);
          });
          break;
        case 5:
          input.readInt(true);
          // Stored as a byte; the runtime divides by 255 too.
          slot.alpha = readKeys(input, frameCount, 1, (key) => set(key, "value", input.readUnsignedByte() / 255, 0));
          break;
        default:
          throw new Error(`Unknown slot timeline type ${type}.`);
      }
    }
  }
  if (Object.keys(slotMaps).length > 0) animation.slots = slotMaps;

  // Bone timelines.
  const boneMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const bone: Json = {};
    boneMaps[names.bones[input.readInt(true)]] = bone;
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const type = input.readByte();
      const frameCount = input.readInt(true);
      const name = BONE_TIMELINES[type];
      if (!name) throw new Error(`Unknown bone timeline type ${type}.`);
      if (name === "inherit") {
        const keys: Json[] = [];
        for (let frame = 0; frame < frameCount; frame++) {
          const key = timeKey(input);
          set(key, "inherit", INHERITS[input.readByte()], "normal");
          keys.push(key);
        }
        bone.inherit = keys;
        continue;
      }
      input.readInt(true); // Bezier count.
      const fallback = name.startsWith("scale") ? 1 : 0;
      bone[name] =
        name === "translate" || name === "scale" || name === "shear"
          ? readKeys(input, frameCount, 2, (key) => {
              set(key, "x", input.readFloat(), fallback);
              set(key, "y", input.readFloat(), fallback);
            })
          : readKeys(input, frameCount, 1, (key) => set(key, "value", input.readFloat(), fallback));
    }
  }
  if (Object.keys(boneMaps).length > 0) animation.bones = boneMaps;

  // IK constraint timelines. Curves are flagged per key rather than in a curve byte.
  const ikMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = names.iks[input.readInt(true)];
    const frameCount = input.readInt(true);
    input.readInt(true); // Bezier count.
    const keys: Json[] = [];
    let flags = input.readByte();
    const ikKey = () => {
      const key = timeKey(input);
      set(key, "mix", (flags & 1) !== 0 ? ((flags & 2) !== 0 ? input.readFloat() : 1) : 0, 1);
      set(key, "softness", (flags & 4) !== 0 ? input.readFloat() : 0, 0);
      set(key, "bendPositive", (flags & 8) !== 0, true);
      set(key, "compress", (flags & 16) !== 0, false);
      set(key, "stretch", (flags & 32) !== 0, false);
      return key;
    };
    let key = ikKey();
    for (let frame = 0; ; frame++) {
      keys.push(key);
      if (frame === frameCount - 1) break;
      flags = input.readByte();
      const next = ikKey();
      if ((flags & 64) !== 0) key.curve = "stepped";
      else if ((flags & 128) !== 0) key.curve = readFloats(input, 8);
      key = next;
    }
    ikMaps[name] = keys;
  }
  if (Object.keys(ikMaps).length > 0) animation.ik = ikMaps;

  // Transform constraint timelines.
  const transformMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = names.transforms[input.readInt(true)];
    const frameCount = input.readInt(true);
    input.readInt(true);
    transformMaps[name] = readKeys(input, frameCount, 6, (key) => {
      const mixRotate = input.readFloat();
      const mixX = input.readFloat();
      const mixY = input.readFloat();
      const mixScaleX = input.readFloat();
      const mixScaleY = input.readFloat();
      set(key, "mixRotate", mixRotate, 1);
      set(key, "mixX", mixX, 1);
      set(key, "mixY", mixY, mixX);
      set(key, "mixScaleX", mixScaleX, 1);
      set(key, "mixScaleY", mixScaleY, mixScaleX);
      set(key, "mixShearY", input.readFloat(), 1);
    });
  }
  if (Object.keys(transformMaps).length > 0) animation.transform = transformMaps;

  // Path constraint timelines.
  const pathMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const name = names.paths[input.readInt(true)];
    const path: Json = {};
    pathMaps[name] = path;
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const type = input.readByte();
      const frameCount = input.readInt(true);
      input.readInt(true);
      if (type === 0 || type === 1) {
        path[type === 0 ? "position" : "spacing"] = readKeys(input, frameCount, 1, (key) => set(key, "value", input.readFloat(), 0));
      } else if (type === 2) {
        path.mix = readKeys(input, frameCount, 3, (key) => {
          set(key, "mixRotate", input.readFloat(), 1);
          const mixX = input.readFloat();
          set(key, "mixX", mixX, 1);
          set(key, "mixY", input.readFloat(), mixX);
        });
      } else throw new Error(`Unknown path timeline type ${type}.`);
    }
  }
  if (Object.keys(pathMaps).length > 0) animation.path = pathMaps;

  // Physics timelines. Index 0 in the file means every constraint, which JSON names "".
  const physicsMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const index = input.readInt(true) - 1;
    const name = index === -1 ? "" : names.physics[index];
    const constraint: Json = {};
    physicsMaps[name] = constraint;
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const type = input.readByte();
      const frameCount = input.readInt(true);
      const timeline = PHYSICS_TIMELINES[type];
      if (!timeline) throw new Error(`Unknown physics timeline type ${type}.`);
      if (timeline === "reset") {
        const keys: Json[] = [];
        for (let frame = 0; frame < frameCount; frame++) keys.push(timeKey(input));
        constraint.reset = keys;
        continue;
      }
      input.readInt(true);
      constraint[timeline] = readKeys(input, frameCount, 1, (key) => set(key, "value", input.readFloat(), 0));
    }
  }
  if (Object.keys(physicsMaps).length > 0) animation.physics = physicsMaps;

  // Deform and sequence timelines, by skin, slot and attachment.
  const attachmentMaps: Json = {};
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const skinName = names.skins[input.readInt(true)];
    const skin: Json = (attachmentMaps[skinName] as Json | undefined) ?? {};
    attachmentMaps[skinName] = skin;
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const slotName = names.slots[input.readInt(true)];
      const slot: Json = (skin[slotName] as Json | undefined) ?? {};
      skin[slotName] = slot;
      for (let iii = 0, nnn = input.readInt(true); iii < nnn; iii++) {
        const attachmentName = required(input.readStringRef(), "Attachment name");
        const attachment: Json = (slot[attachmentName] as Json | undefined) ?? {};
        slot[attachmentName] = attachment;
        const type = input.readByte();
        const frameCount = input.readInt(true);
        if (type === 0) {
          input.readInt(true);
          attachment.deform = readDeformKeys(input, frameCount);
        } else if (type === 1) {
          const keys: Json[] = [];
          for (let frame = 0; frame < frameCount; frame++) {
            const key = timeKey(input);
            const modeAndIndex = input.readInt32();
            set(key, "mode", SEQUENCE_MODES[modeAndIndex & 0xf], "hold");
            set(key, "index", modeAndIndex >> 4, 0);
            // JSON carries the delay over from the previous key when it's left out, so always write it.
            key.delay = input.readFloat();
            keys.push(key);
          }
          attachment.sequence = keys;
        } else throw new Error(`Unknown attachment timeline type ${type}.`);
      }
    }
  }
  if (Object.keys(attachmentMaps).length > 0) animation.attachments = attachmentMaps;

  // Draw order.
  const drawOrderCount = input.readInt(true);
  if (drawOrderCount > 0) {
    const keys: Json[] = [];
    for (let i = 0; i < drawOrderCount; i++) {
      const key = timeKey(input);
      const offsets: Json[] = [];
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
        // Read as the runtime does: a negative offset comes back through 32-bit overflow.
        offsets.push({ slot: names.slots[input.readInt(true)], offset: input.readInt(true) });
      }
      if (offsets.length > 0) key.offsets = offsets;
      keys.push(key);
    }
    animation.drawOrder = keys;
  }

  // Events.
  const eventCount = input.readInt(true);
  if (eventCount > 0) {
    const keys: Json[] = [];
    for (let i = 0; i < eventCount; i++) {
      const key = timeKey(input);
      const event = names.events[input.readInt(true)];
      key.name = event.name;
      key.int = input.readInt(false);
      key.float = input.readFloat();
      set(key, "string", input.readString(), null);
      if (event.audio) {
        key.volume = input.readFloat();
        key.balance = input.readFloat();
      }
      keys.push(key);
    }
    animation.events = keys;
  }
  return animation;
}

/**
 * Keys of a curve timeline: each key's time and values, and on every key but the last the curve
 * to the next key ("stepped", or 4 bezier control values per timeline value).
 */
function readKeys(input: BinaryInput, frameCount: number, values: number, readValues: (key: Json) => void): Json[] {
  const keys: Json[] = [];
  const nextKey = () => {
    const key = timeKey(input);
    readValues(key);
    return key;
  };
  let key = nextKey();
  for (let frame = 0; ; frame++) {
    keys.push(key);
    if (frame === frameCount - 1) break;
    const next = nextKey();
    const curve = input.readByte();
    if (curve === CURVE_STEPPED) key.curve = "stepped";
    else if (curve === CURVE_BEZIER) key.curve = readFloats(input, values * 4);
    key = next;
  }
  return keys;
}

/**
 * Deform keys: offsets from the setup vertices, from `offset` on (none means the setup shape).
 * Unlike other timelines, a key's vertices come after the curve leading into it, not with its time.
 */
function readDeformKeys(input: BinaryInput, frameCount: number): Json[] {
  const keys: Json[] = [];
  let key = timeKey(input);
  for (let frame = 0; ; frame++) {
    const count = input.readInt(true);
    if (count > 0) {
      set(key, "offset", input.readInt(true), 0);
      key.vertices = readFloats(input, count);
    }
    keys.push(key);
    if (frame === frameCount - 1) break;
    const next = timeKey(input);
    const curve = input.readByte();
    if (curve === CURVE_STEPPED) key.curve = "stepped";
    else if (curve === CURVE_BEZIER) key.curve = readFloats(input, 4);
    key = next;
  }
  return keys;
}

function timeKey(input: BinaryInput): Json {
  const key: Json = {};
  set(key, "time", input.readFloat(), 0);
  return key;
}

function readNames(input: BinaryInput, names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0, n = input.readInt(true); i < n; i++) out.push(names[input.readInt(true)]);
  return out;
}

function readFloats(input: BinaryInput, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = input.readFloat();
  return out;
}

function readShorts(input: BinaryInput, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = input.readInt(true);
  return out;
}

/** Color channel bytes as hex, as JSON stores colors. */
function colorBytes(input: BinaryInput, channels: number) {
  let hex = "";
  for (let i = 0; i < channels; i++) hex += input.readUnsignedByte().toString(16).padStart(2, "0");
  return hex;
}

function rgba8888(value: number) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function rgb888(value: number) {
  return (value & 0xffffff).toString(16).padStart(6, "0");
}

/** Sets `key` unless `value` is what SkeletonJson would use when the key is missing. */
function set(map: Json, key: string, value: unknown, fallback: unknown) {
  if (value !== fallback) map[key] = value;
}

function required(value: string | null, what: string): string {
  if (!value) throw new Error(`${what} must not be null.`);
  return value;
}

/** Reads the binary format's primitives the way spine-core's BinaryInput does. */
class BinaryInput {
  readonly strings: string[] = [];
  index = 0;
  private readonly view: DataView;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }

  get length() {
    return this.view.byteLength;
  }

  readByte() {
    return this.view.getInt8(this.index++);
  }

  readUnsignedByte() {
    return this.view.getUint8(this.index++);
  }

  readInt32() {
    const value = this.view.getInt32(this.index);
    this.index += 4;
    return value;
  }

  /** Variable-length int; zigzag-decoded unless `optimizePositive`. */
  readInt(optimizePositive: boolean) {
    let b = this.readByte();
    let result = b & 0x7f;
    if ((b & 0x80) !== 0) {
      b = this.readByte();
      result |= (b & 0x7f) << 7;
      if ((b & 0x80) !== 0) {
        b = this.readByte();
        result |= (b & 0x7f) << 14;
        if ((b & 0x80) !== 0) {
          b = this.readByte();
          result |= (b & 0x7f) << 21;
          if ((b & 0x80) !== 0) {
            b = this.readByte();
            result |= (b & 0x7f) << 28;
          }
        }
      }
    }
    return optimizePositive ? result : (result >>> 1) ^ -(result & 1);
  }

  readStringRef() {
    const index = this.readInt(true);
    return index === 0 ? null : this.strings[index - 1];
  }

  /** Length-prefixed modified UTF-8: 0 is null, 1 is "". */
  readString(): string | null {
    let byteCount = this.readInt(true);
    if (byteCount === 0) return null;
    if (byteCount === 1) return "";
    byteCount--;
    let chars = "";
    for (let i = 0; i < byteCount; ) {
      const b = this.readUnsignedByte();
      switch (b >> 4) {
        case 12:
        case 13:
          chars += String.fromCharCode(((b & 0x1f) << 6) | (this.readByte() & 0x3f));
          i += 2;
          break;
        case 14:
          chars += String.fromCharCode(((b & 0x0f) << 12) | ((this.readByte() & 0x3f) << 6) | (this.readByte() & 0x3f));
          i += 3;
          break;
        default:
          chars += String.fromCharCode(b);
          i++;
      }
    }
    return chars;
  }

  /** A 32-bit float, written back as the shortest decimal that reads as the same float. */
  readFloat() {
    const value = this.view.getFloat32(this.index);
    this.index += 4;
    return shortest(value);
  }

  readBoolean() {
    return this.readByte() !== 0;
  }
}

function shortest(value: number) {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  for (let digits = 1; digits < 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}
