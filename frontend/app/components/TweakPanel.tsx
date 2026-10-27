import { Crosshair, EyeOff, FlipHorizontal2, Loader2, RotateCcw, Save, SlidersHorizontal, Wind, X } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Slider } from "~/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Toggle } from "~/components/ui/toggle";
import {
  DEFAULT_BONE,
  DEFAULT_PART,
  DEFAULT_TWEAKS,
  TWEAK_BLEND_MODES,
  isDefaultBone,
  isDefaultPart,
  type BoneTweak,
  type PartTweak,
  type RigInfo,
  type SpineTweaks,
  type TweakBlendMode,
} from "~/lib/spine-tweaks";
import { cn } from "~/lib/utils";

interface TweakPanelProps {
  tweaks: SpineTweaks;
  onChange: (next: SpineTweaks) => void;
  /** What the loaded rig supports; null until the runtime has loaded it. */
  rig: RigInfo | null;
  selectedPart: string | null;
  onSelectPart: (part: string | null) => void;
  picking: boolean;
  onPickingChange: (picking: boolean) => void;
  selectedBone: string | null;
  onSelectBone: (bone: string | null) => void;
  /** Writes the tweaks into the remix's skeleton file. */
  save: { onSave: () => void; pending: boolean; disabledReason: string | null };
  className?: string;
}

const BLEND_LABELS: Record<TweakBlendMode, string> = {
  rig: "As rigged",
  normal: "Normal",
  additive: "Additive (glow)",
  multiply: "Multiply",
  screen: "Screen",
};

const NONE = "__none";

/** Live, client-side edits to the previewed rig: color, transform, playback, rig features and individual parts. */
export function TweakPanel({
  tweaks,
  onChange,
  rig,
  selectedPart,
  onSelectPart,
  picking,
  onPickingChange,
  selectedBone,
  onSelectBone,
  save,
  className,
}: TweakPanelProps) {
  const set = (patch: Partial<SpineTweaks>) => onChange({ ...tweaks, ...patch });

  const setPart = (name: string, patch: Partial<PartTweak> | null) => {
    const { [name]: current, ...rest } = tweaks.parts;
    const next = patch ? { ...(current ?? DEFAULT_PART), ...patch } : DEFAULT_PART;
    set({ parts: isDefaultPart(next) ? rest : { ...rest, [name]: next } });
  };

  const setBone = (name: string, patch: Partial<BoneTweak> | null) => {
    const { [name]: current, ...rest } = tweaks.bones;
    const next = patch ? { ...(current ?? DEFAULT_BONE), ...patch } : DEFAULT_BONE;
    set({ bones: isDefaultBone(next) ? rest : { ...rest, [name]: next } });
  };

  const part = selectedPart ? (tweaks.parts[selectedPart] ?? DEFAULT_PART) : null;
  const bone = selectedBone ? (tweaks.bones[selectedBone] ?? DEFAULT_BONE) : null;
  const skins = tweaks.skins ?? (rig?.baseSkin ? [rig.baseSkin] : []);

  const toggleSkin = (name: string, on: boolean) => {
    const next = on ? [...skins, name] : skins.filter((s) => s !== name);
    const isBase = next.length === 0 || (next.length === 1 && next[0] === rig?.baseSkin);
    set({ skins: isBase ? null : next });
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="flex items-center gap-1.5 leading-none font-semibold">
            <SlidersHorizontal className="size-4 text-muted-foreground" /> Tweak the rig
          </h2>
          <p className="text-sm text-muted-foreground">
            {save.disabledReason ??
              "Save writes Look, Rig and Parts edits into the remix's skeleton file. Motion and debug settings are preview only."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(DEFAULT_TWEAKS);
              onSelectPart(null);
              onSelectBone(null);
            }}
          >
            <RotateCcw /> Reset all
          </Button>
          <Button size="sm" onClick={save.onSave} disabled={save.pending || save.disabledReason !== null}>
            {save.pending ? <Loader2 className="animate-spin" /> : <Save />}
            {save.pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="look" className="gap-0">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="look">Look</TabsTrigger>
          <TabsTrigger value="motion">Motion</TabsTrigger>
          <TabsTrigger value="rig">Rig</TabsTrigger>
          <TabsTrigger value="parts">Parts</TabsTrigger>
        </TabsList>

        <TabsContent value="look" className="flex flex-col gap-4 pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField id="tw-tint" label="Tint" value={tweaks.tint} onChange={(tint) => set({ tint })} onClear={tweaks.tint !== "#ffffff" ? () => set({ tint: "#ffffff" }) : undefined} />
            <ColorField
              id="tw-shadow"
              label="Shadow color"
              hint="Recolors the darks, keeps highlights"
              value={tweaks.shadow}
              onChange={(shadow) => set({ shadow })}
              onClear={tweaks.shadow ? () => set({ shadow: null }) : undefined}
            />
          </div>
          <SliderField id="tw-alpha" label="Opacity" value={tweaks.alpha * 100} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set({ alpha: v / 100 })} />
          <BlendField id="tw-blend" label="Blend mode" value={tweaks.blend} onChange={(blend) => set({ blend })} />
          <CheckField id="tw-pixel" label="Pixel-crisp textures" checked={tweaks.pixelated} onChange={(pixelated) => set({ pixelated })} />

          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Transform</span>
            <Toggle size="sm" variant="outline" pressed={tweaks.flipX} onPressedChange={(flipX) => set({ flipX })} aria-label="Flip horizontally">
              <FlipHorizontal2 /> Flip
            </Toggle>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SliderField id="tw-sx" label="Width" value={tweaks.scaleX * 100} min={50} max={150} step={5} format={(v) => `${v}%`} onChange={(v) => set({ scaleX: v / 100 })} />
            <SliderField id="tw-sy" label="Height" value={tweaks.scaleY * 100} min={50} max={150} step={5} format={(v) => `${v}%`} onChange={(v) => set({ scaleY: v / 100 })} />
          </div>

          <Separator />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Debug overlays</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["meshes", "regions", "bounds", "clipping"] as const).map((key) => (
                <CheckField
                  key={key}
                  id={`tw-debug-${key}`}
                  label={{ meshes: "Mesh triangles", regions: "Region quads", bounds: "Bounding boxes", clipping: "Clipping" }[key]}
                  checked={tweaks.debug[key]}
                  onChange={(on) => set({ debug: { ...tweaks.debug, [key]: on } })}
                />
              ))}
            </div>
          </fieldset>
        </TabsContent>

        <TabsContent value="motion" className="flex flex-col gap-4 pt-4">
          <SliderField
            id="tw-mix"
            label="Crossfade between animations"
            value={tweaks.mix}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${v.toFixed(2)}s`}
            onChange={(mix) => set({ mix })}
          />
          <CheckField id="tw-reverse" label="Play in reverse" checked={tweaks.reverse} onChange={(reverse) => set({ reverse })} />
          <div className="flex flex-col gap-3">
            <CheckField
              id="tw-hold"
              label="Hold a frame"
              checked={tweaks.scrub !== null}
              onChange={(on) => set({ scrub: on ? 0 : null })}
            />
            <SliderField
              id="tw-scrub"
              label="Frame"
              value={(tweaks.scrub ?? 0) * 100}
              min={0}
              max={100}
              step={1}
              format={(v) => `${v}%`}
              disabled={tweaks.scrub === null}
              onChange={(v) => set({ scrub: v / 100 })}
            />
          </div>

          <Separator />
          <div className="flex flex-col gap-2">
            <Label htmlFor="tw-layer">Layer a second animation</Label>
            <Select value={tweaks.layer ?? NONE} onValueChange={(v) => set({ layer: v === NONE ? null : v })} disabled={!rig}>
              <SelectTrigger id="tw-layer" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {rig?.animations.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Plays on top of the selected animation, e.g. a mouth or blink loop over a walk.</p>
          </div>
          <SliderField
            id="tw-layer-alpha"
            label="Layer weight"
            value={tweaks.layerAlpha * 100}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            disabled={!tweaks.layer}
            onChange={(v) => set({ layerAlpha: v / 100 })}
          />
        </TabsContent>

        <TabsContent value="rig" className="flex flex-col gap-4 pt-4">
          {!rig ? (
            <p className="text-sm text-muted-foreground">Loading the rig…</p>
          ) : (
            <>
              {rig.skins.length > 1 && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">Skins</legend>
                  <p className="mb-1 text-xs text-muted-foreground">Tick more than one to combine them, e.g. a body skin with an eye skin.</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {rig.skins.map((s) => (
                      <CheckField key={s} id={`tw-skin-${s}`} label={s} checked={skins.includes(s)} onChange={(on) => toggleSkin(s, on)} />
                    ))}
                  </div>
                </fieldset>
              )}

              {rig.physics > 0 && (
                <Section
                  title={`Physics · ${rig.physics} constraints`}
                  action={
                    <Button variant="outline" size="sm" onClick={() => set({ kick: tweaks.kick + 1 })}>
                      <Wind /> Shake
                    </Button>
                  }
                >
                  <SliderField id="tw-phys" label="Physics amount" value={tweaks.physicsMix * 100} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set({ physicsMix: v / 100 })} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <SliderField id="tw-wind" label="Wind" value={tweaks.wind * 100} min={-100} max={100} step={5} format={(v) => `${v}`} onChange={(v) => set({ wind: v / 100 })} />
                    <SliderField id="tw-gravity" label="Gravity" value={tweaks.gravity * 100} min={-100} max={100} step={5} format={(v) => `${v}`} onChange={(v) => set({ gravity: v / 100 })} />
                  </div>
                  <SliderField id="tw-stiff" label="Stiffness" value={tweaks.stiffness * 100} min={10} max={300} step={10} format={(v) => `${v}%`} onChange={(v) => set({ stiffness: v / 100 })} />
                </Section>
              )}

              {rig.ik > 0 && (
                <Section title={`IK · ${rig.ik} constraints`}>
                  <SliderField id="tw-ik" label="IK strength" value={tweaks.ikMix * 100} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set({ ikMix: v / 100 })} />
                  <CheckField id="tw-ikflip" label="Flip joint bend direction" checked={tweaks.ikFlip} onChange={(ikFlip) => set({ ikFlip })} />
                </Section>
              )}

              {rig.transform > 0 && (
                <Section title={`Transform constraints · ${rig.transform}`}>
                  <SliderField id="tw-tc" label="Constraint strength" value={tweaks.transformMix * 100} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set({ transformMix: v / 100 })} />
                </Section>
              )}

              {rig.skins.length <= 1 && rig.physics + rig.ik + rig.transform === 0 && (
                <p className="text-sm text-muted-foreground">This rig has one skin and no physics or constraints. Try the Parts tab.</p>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="parts" className="flex flex-col gap-4 pt-4">
          {!rig ? (
            <p className="text-sm text-muted-foreground">Loading the rig…</p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="tw-part">Part</Label>
                <div className="flex gap-2">
                  <Select value={selectedPart ?? NONE} onValueChange={(v) => onSelectPart(v === NONE ? null : v)}>
                    <SelectTrigger id="tw-part" size="sm" className="min-w-0 flex-1">
                      <SelectValue placeholder="Choose a part" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {rig.parts.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Toggle size="sm" variant="outline" pressed={picking} onPressedChange={onPickingChange} aria-label="Pick a part on the preview">
                    <Crosshair /> Pick
                  </Toggle>
                </div>
                <p className="text-xs text-muted-foreground">
                  {picking ? "Click a part on the preview to select it." : "Or turn on Pick and click the preview."}
                </p>
              </div>

              <EditedList
                label="Edited parts"
                names={Object.keys(tweaks.parts)}
                selected={selectedPart}
                onSelect={onSelectPart}
                onClear={(n) => setPart(n, null)}
              />

              {selectedPart && part && (
                <Section
                  title={selectedPart}
                  action={
                    <Button variant="ghost" size="sm" onClick={() => setPart(selectedPart, null)} disabled={isDefaultPart(part)}>
                      <RotateCcw /> Reset part
                    </Button>
                  }
                >
                  <CheckField
                    id="tw-part-hide"
                    label={
                      <>
                        <EyeOff className="size-4 text-muted-foreground" /> Hide this part
                      </>
                    }
                    checked={part.hidden}
                    onChange={(hidden) => setPart(selectedPart, { hidden })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Offsets follow the part's bone, so a fix stays aligned through every animation. Use them to line up a part the
                    image model shifted.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <SliderField id="tw-part-dx" label="Offset X" value={part.dx} min={-15} max={15} step={0.25} format={(v) => `${v.toFixed(2)}%`} onChange={(dx) => setPart(selectedPart, { dx })} />
                    <SliderField id="tw-part-dy" label="Offset Y" value={part.dy} min={-15} max={15} step={0.25} format={(v) => `${v.toFixed(2)}%`} onChange={(dy) => setPart(selectedPart, { dy })} />
                    <SliderField id="tw-part-scale" label="Scale" value={part.scale * 100} min={50} max={200} step={1} format={(v) => `${v}%`} onChange={(v) => setPart(selectedPart, { scale: v / 100 })} />
                    <SliderField id="tw-part-rot" label="Rotate" value={part.rotation} min={-180} max={180} step={1} format={(v) => `${v}°`} onChange={(rotation) => setPart(selectedPart, { rotation })} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ColorField
                      id="tw-part-color"
                      label="Part tint"
                      value={part.color}
                      onChange={(color) => setPart(selectedPart, { color })}
                      onClear={part.color ? () => setPart(selectedPart, { color: null }) : undefined}
                    />
                    <ColorField
                      id="tw-part-shadow"
                      label="Part shadow"
                      value={part.shadow}
                      onChange={(shadow) => setPart(selectedPart, { shadow })}
                      onClear={part.shadow ? () => setPart(selectedPart, { shadow: null }) : undefined}
                    />
                  </div>
                  <BlendField id="tw-part-blend" label="Part blend mode" value={part.blend} onChange={(blend) => setPart(selectedPart, { blend })} />
                </Section>
              )}

              <Separator />
              <div className="flex flex-col gap-2">
                <Label htmlFor="tw-bone">Bone sculpt</Label>
                <Select value={selectedBone ?? NONE} onValueChange={(v) => onSelectBone(v === NONE ? null : v)}>
                  <SelectTrigger id="tw-bone" size="sm" className="w-full">
                    <SelectValue placeholder="Choose a bone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {rig.bones.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Changes the bone's rest pose, so every animation keeps working. Scaling a bone also scales its children: try a
                  bigger head or longer arms. Turn on Labels in the Skeleton view to find bones.
                </p>
              </div>

              <EditedList
                label="Edited bones"
                names={Object.keys(tweaks.bones)}
                selected={selectedBone}
                onSelect={onSelectBone}
                onClear={(n) => setBone(n, null)}
              />

              {selectedBone && bone && (
                <Section
                  title={selectedBone}
                  action={
                    <Button variant="ghost" size="sm" onClick={() => setBone(selectedBone, null)} disabled={isDefaultBone(bone)}>
                      <RotateCcw /> Reset bone
                    </Button>
                  }
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <SliderField id="tw-bone-sx" label="Length" value={bone.scaleX * 100} min={25} max={250} step={5} format={(v) => `${v}%`} onChange={(v) => setBone(selectedBone, { scaleX: v / 100 })} />
                    <SliderField id="tw-bone-sy" label="Thickness" value={bone.scaleY * 100} min={25} max={250} step={5} format={(v) => `${v}%`} onChange={(v) => setBone(selectedBone, { scaleY: v / 100 })} />
                  </div>
                  <SliderField id="tw-bone-rot" label="Rest rotation" value={bone.rotation} min={-180} max={180} step={1} format={(v) => `${v}°`} onChange={(rotation) => setBone(selectedBone, { rotation })} />
                </Section>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border p-3">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function SliderField({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className={cn("text-xs", disabled && "opacity-50")}>
          {label}
        </Label>
        <span className="text-xs tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      <Slider id={id} min={min} max={max} step={step} value={[value]} disabled={disabled} onValueChange={([v]) => onChange(v)} aria-label={label} />
    </div>
  );
}

function CheckField({ id, label, checked, onChange }: { id: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="min-w-0 font-normal">
        <span className="flex items-center gap-1.5 truncate">{label}</span>
      </Label>
    </div>
  );
}

function ColorField({
  id,
  label,
  hint,
  value,
  onChange,
  onClear,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string | null;
  onChange: (hex: string) => void;
  onClear?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "relative size-8 shrink-0 overflow-hidden rounded-md border shadow-xs",
            !value && "bg-[repeating-conic-gradient(var(--color-muted)_0_25%,var(--color-background)_0_50%)] bg-size-[8px_8px]",
          )}
          style={value ? { backgroundColor: value } : undefined}
        >
          <input
            id={id}
            type="color"
            value={value ?? "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </span>
        <span className={cn("text-xs text-muted-foreground", value && "font-mono uppercase")}>{value ?? "Off"}</span>
        {onClear && (
          <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={onClear} aria-label={`Clear ${label.toLowerCase()}`}>
            <X />
          </Button>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function BlendField({ id, label, value, onChange }: { id: string; label: string; value: TweakBlendMode; onChange: (v: TweakBlendMode) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value} onValueChange={(v) => onChange(TWEAK_BLEND_MODES.find((m) => m === v) ?? "rig")}>
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TWEAK_BLEND_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {BLEND_LABELS[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function EditedList({
  label,
  names,
  selected,
  onSelect,
  onClear,
}: {
  label: string;
  names: string[];
  selected: string | null;
  onSelect: (name: string) => void;
  onClear: (name: string) => void;
}) {
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-xs text-muted-foreground">{label}:</span>
      {names.map((n) => (
        <Badge key={n} variant={n === selected ? "default" : "secondary"} className="gap-0 p-0">
          <button type="button" className="cursor-pointer py-0.5 pr-1 pl-2" onClick={() => onSelect(n)}>
            {n}
          </button>
          <button type="button" className="cursor-pointer rounded-r-md py-0.5 pr-1.5 pl-0.5 opacity-70 hover:opacity-100" onClick={() => onClear(n)} aria-label={`Reset ${n}`}>
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}
