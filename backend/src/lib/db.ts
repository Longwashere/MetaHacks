import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE } from "./config.js";
import { objectUrl } from "./storage.js";
import type { ArtStyle } from "./types.js";

// Supabase client (service role: bypasses RLS) and the row shapes of supabase/migrations/.

let client: SupabaseClient | null = null;

/** The Supabase client. Throws if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set. */
export function db(): SupabaseClient {
  if (!SUPABASE) throw new Error("Supabase isn't configured; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.");
  client ??= createClient(SUPABASE.url, SUPABASE.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Throws a plain Error for a Supabase error, so route handlers can let it reach Express. */
export function check<T>(res: { data: T; error: null } | { data: unknown; error: { message: string } }): T {
  if (res.error) throw new Error(`Database error: ${res.error.message}`);
  return res.data as T;
}

export type Visibility = "public" | "private";
export type Plan = "free" | "pro";

export interface ProfileRow {
  id: string;
  name: string;
  avatar_url: string | null;
  stripe_customer_id: string | null;
  plan: Plan;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  created_at: string;
}

export interface AssetFileKeys {
  skeleton: string;
  atlas: string;
  textures: string[];
  premultipliedAlpha: boolean;
  skin: string | null;
}

export interface AssetRow {
  id: string;
  owner_id: string | null;
  author_id: string;
  author_name: string;
  name: string;
  description: string;
  category: string;
  style: ArtStyle;
  tags: string[];
  prompt: string | null;
  remix_of: string | null;
  remix_of_name: string | null;
  copy_of: string | null;
  copy_of_name: string | null;
  visibility: Visibility;
  spine_version: string;
  bone_count: number;
  slot_count: number;
  animations: { name: string; durationSec: number; loop: boolean }[];
  accent: string;
  downloads: number;
  saves: number;
  thumbnail_url: string | null;
  files: AssetFileKeys | null;
  tint: string | null;
  created_at: string;
}

/** Columns to select for an asset (everything but search_text). */
export const ASSET_COLUMNS =
  "id, owner_id, author_id, author_name, name, description, category, style, tags, prompt, remix_of, remix_of_name, copy_of, copy_of_name, visibility, spine_version, bone_count, slot_count, animations, accent, downloads, saves, thumbnail_url, files, tint, created_at";

export const PROFILE_COLUMNS =
  "id, name, avatar_url, stripe_customer_id, plan, subscription_id, subscription_status, current_period_end, created_at";

export const REMIX_JOB_COLUMNS =
  "id, user_id, base_asset_id, api_version, input, status, error, edit_prompt, prompt_status, asset_id, created_at";

export interface RemixJobRow {
  id: string;
  user_id: string;
  base_asset_id: string | null;
  api_version: "v1" | "v2" | "v3";
  input: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  edit_prompt: string | null;
  prompt_status: string;
  asset_id: string | null;
  created_at: string;
}

/** The asset shape the frontend expects (SpineAsset in frontend/app/lib/types.ts). */
export interface SpineAsset {
  id: string;
  name: string;
  description: string;
  category: string;
  style: ArtStyle;
  tags: string[];
  prompt: string | null;
  remixOf: { id: string; name: string } | null;
  copyOf: { id: string; name: string } | null;
  visibility: Visibility;
  author: { id: string; name: string };
  createdAt: string;
  spineVersion: string;
  boneCount: number;
  slotCount: number;
  animations: AssetRow["animations"];
  accent: string;
  downloads: number;
  saves: number;
  thumbnailUrl: string | null;
  files: {
    skeletonUrl: string;
    atlasUrl: string;
    textureUrls: string[];
    premultipliedAlpha: boolean;
    skin: string | null;
  } | null;
  tint: string | null;
}

export function toSpineAsset(row: AssetRow): SpineAsset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    style: row.style,
    tags: row.tags,
    prompt: row.prompt,
    remixOf: row.remix_of ? { id: row.remix_of, name: row.remix_of_name ?? "" } : null,
    copyOf: row.copy_of ? { id: row.copy_of, name: row.copy_of_name ?? "" } : null,
    visibility: row.visibility,
    author: { id: row.author_id, name: row.author_name },
    createdAt: row.created_at,
    spineVersion: row.spine_version,
    boneCount: row.bone_count,
    slotCount: row.slot_count,
    animations: row.animations,
    accent: row.accent,
    downloads: row.downloads,
    saves: row.saves,
    thumbnailUrl: row.thumbnail_url,
    files: row.files && {
      skeletonUrl: objectUrl(row.files.skeleton),
      atlasUrl: objectUrl(row.files.atlas),
      textureUrls: row.files.textures.map(objectUrl),
      premultipliedAlpha: row.files.premultipliedAlpha,
      skin: row.files.skin,
    },
    tint: row.tint,
  };
}
