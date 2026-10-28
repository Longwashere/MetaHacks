import { ImagePlus, Loader2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

/** Longest side the reference is sent at; the backend stores and shows it to Muse at this size. */
const MAX_SIDE = 1024;
const ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * An optional reference image for a remix. The chosen file is shrunk to a JPEG in the browser and
 * submitted as a data URL in the `referenceImage` field. Muse Spark reads it and repaints the rig
 * to match its colours, materials and, under "Auto", its art style.
 */
export function ReferenceImageField({ error, className }: { error?: string; className?: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const message = readError ?? error;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPT.split(",").includes(file.type)) {
      setReadError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    setReading(true);
    setReadError(null);
    try {
      setImage(await shrinkToJpeg(file));
    } catch {
      setReadError("Couldn't read that image. Try another file.");
    } finally {
      setReading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor="referenceImageFile">
        Reference image <span className="font-normal text-muted-foreground">(optional)</span>
      </Label>
      {image && <input type="hidden" name="referenceImage" value={image} />}
      {image ? (
        <div className="flex items-center gap-3 rounded-lg border p-2">
          <img src={image} alt="Reference for the new look" className="size-20 shrink-0 rounded-md bg-muted object-contain" />
          <p className="flex-1 text-xs text-muted-foreground">
            Muse will match this image's colours, materials and outfit. Under Auto, it also takes its art style.
          </p>
          <Button type="button" variant="ghost" size="icon" onClick={() => setImage(null)} aria-label="Remove reference image">
            <X />
          </Button>
        </div>
      ) : (
        <label
          htmlFor="referenceImageFile"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void choose(e.dataTransfer.files[0]);
          }}
          className={cn(
            "flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground transition-colors hover:bg-accent",
            dragging && "border-primary bg-accent",
            message && "border-destructive",
          )}
        >
          {reading ? <Loader2 className="size-5 shrink-0 animate-spin" /> : <ImagePlus className="size-5 shrink-0" />}
          <span>Drop concept art, a character or a screenshot to match its look, or click to choose one.</span>
        </label>
      )}
      <input
        id="referenceImageFile"
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          void choose(e.target.files?.[0]);
          e.target.value = "";
        }}
        aria-invalid={Boolean(message)}
        aria-describedby={message ? "referenceImage-error" : undefined}
      />
      {message && (
        <p id="referenceImage-error" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

/** The image as a JPEG data URL, at most MAX_SIDE on its longer side, transparency on white. */
async function shrinkToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    bitmap.close();
  }
}
