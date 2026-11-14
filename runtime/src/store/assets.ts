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
}

function rowToAsset(row: AssetRow): AssetCard {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as AssetKind,
    name: row.name,
    description: row.description,
    referenceImagePath: row.reference_image_path ?? undefined,
  };
}

export interface CreateAssetInput {
  projectId: string;
  kind: AssetKind;
  name: string;
  description: string;
  referenceImagePath?: string;
}

export function createAsset(db: DatabaseSync, input: CreateAssetInput): AssetCard {
  const asset: AssetCard = {
    id: randomUUID(),
    projectId: input.projectId,
    kind: input.kind,
    name: input.name,
    description: input.description,
    referenceImagePath: input.referenceImagePath,
  };
  db.prepare(
    `INSERT INTO video_assets
       (id, project_id, kind, name, description, reference_image_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    asset.projectId,
    asset.kind,
    asset.name,
    asset.description,
    asset.referenceImagePath ?? null,
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
       SET name = ?, description = ?, reference_image_path = ?
     WHERE id = ?`,
  ).run(next.name, next.description, next.referenceImagePath ?? null, id);
  return next;
}

export function deleteAsset(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM video_assets WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}
