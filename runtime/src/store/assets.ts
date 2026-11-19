import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AssetCard, AssetKind } from '../types';

interface AssetRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  description: string;
  reference_image_path: string | null;
  candidate_images: string;
  scope: string | null;
  variant_of: string | null;
  lighting_spec: string | null;
  audio_spec: string | null;
  voice_id: string | null;
}

function rowToAsset(row: AssetRow): AssetCard {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as AssetKind,
    name: row.name,
    description: row.description,
    referenceImagePath: row.reference_image_path ?? undefined,
    candidateImages: row.candidate_images
      ? (JSON.parse(row.candidate_images) as string[])
      : [],
    scope: (row.scope as AssetCard['scope']) ?? 'project',
    variantOf: row.variant_of ?? undefined,
    lightingSpec: row.lighting_spec ?? undefined,
    audioSpec: row.audio_spec ?? undefined,
    voiceId: row.voice_id ?? undefined,
  };
}

export interface CreateAssetInput {
  projectId: string;
  kind: AssetKind;
  name: string;
  description: string;
  referenceImagePath?: string;
  candidateImages?: string[];
  /** v1.1：资产层级（series=剧集级共享 / project=集级） */
  scope?: AssetCard['scope'];
  /** v1.1：wardrobe variant 指向主角色卡 ID */
  variantOf?: string;
  /** v1.1：场景灯光规格（色温/方向数值化） */
  lightingSpec?: string;
  /** v1.1：场景声音规格 */
  audioSpec?: string;
  /** v1.1：角色音色绑定（Voice Registry） */
  voiceId?: string;
}

export function createAsset(db: DatabaseSync, input: CreateAssetInput): AssetCard {
  const asset: AssetCard = {
    id: randomUUID(),
    projectId: input.projectId,
    kind: input.kind,
    name: input.name,
    description: input.description,
    referenceImagePath: input.referenceImagePath,
    candidateImages: input.candidateImages ?? [],
    scope: input.scope ?? 'project',
    variantOf: input.variantOf,
    lightingSpec: input.lightingSpec,
    audioSpec: input.audioSpec,
    voiceId: input.voiceId,
  };
  db.prepare(
    `INSERT INTO video_assets
       (id, project_id, kind, name, description, reference_image_path, candidate_images,
        scope, variant_of, lighting_spec, audio_spec, voice_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    asset.projectId,
    asset.kind,
    asset.name,
    asset.description,
    asset.referenceImagePath ?? null,
    JSON.stringify(asset.candidateImages),
    asset.scope ?? 'project',
    asset.variantOf ?? null,
    asset.lightingSpec ?? null,
    asset.audioSpec ?? null,
    asset.voiceId ?? null,
  );
  return asset;
}

export function getAsset(db: DatabaseSync, id: string): AssetCard | undefined {
  const row = db.prepare('SELECT * FROM video_assets WHERE id = ?').get(id) as
    | AssetRow
    | undefined;
  return row ? rowToAsset(row) : undefined;
}

export function listAssetsByProject(
  db: DatabaseSync,
  projectId: string,
  kind?: AssetKind,
): AssetCard[] {
  const rows = kind
    ? (db
        .prepare('SELECT * FROM video_assets WHERE project_id = ? AND kind = ? ORDER BY name')
        .all(projectId, kind) as unknown as AssetRow[])
    : (db
        .prepare('SELECT * FROM video_assets WHERE project_id = ? ORDER BY kind, name')
        .all(projectId) as unknown as AssetRow[]);
  return rows.map(rowToAsset);
}

export interface UpdateAssetFields {
  name?: string;
  description?: string;
  referenceImagePath?: string;
  candidateImages?: string[];
  /** v1.1 */
  scope?: AssetCard['scope'];
  variantOf?: string;
  lightingSpec?: string;
  audioSpec?: string;
  voiceId?: string;
}

export function updateAsset(
  db: DatabaseSync,
  id: string,
  fields: UpdateAssetFields,
): AssetCard | undefined {
  const existing = getAsset(db, id);
  if (!existing) return undefined;
  const next: AssetCard = { ...existing, ...fields };
  db.prepare(
    `UPDATE video_assets
       SET name = ?, description = ?, reference_image_path = ?, candidate_images = ?,
           scope = ?, variant_of = ?, lighting_spec = ?, audio_spec = ?, voice_id = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.description,
    next.referenceImagePath ?? null,
    JSON.stringify(next.candidateImages),
    next.scope ?? 'project',
    next.variantOf ?? null,
    next.lightingSpec ?? null,
    next.audioSpec ?? null,
    next.voiceId ?? null,
    id,
  );
  return next;
}

export function deleteAsset(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM video_assets WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}
