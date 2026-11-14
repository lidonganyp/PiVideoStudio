import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { PromptBundle, Segment, SegmentStatus } from '../types';
import { canSegmentTransition } from '../state-machine';

interface SegmentRow {
  id: string;
  project_id: string;
  seq_order: number;
  source_text: string;
  scene_summary: string;
  character_names: string;
  emotion: string;
  estimated_seconds: number;
  status: string;
  current_version: number;
  prompt_bundle: string | null;
}

function rowToSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    projectId: row.project_id,
    order: row.seq_order,
    sourceText: row.source_text,
    sceneSummary: row.scene_summary,
    characterNames: JSON.parse(row.character_names) as string[],
    emotion: row.emotion,
    estimatedSeconds: row.estimated_seconds,
    status: row.status as SegmentStatus,
    currentVersion: row.current_version,
    prompt: row.prompt_bundle
      ? (JSON.parse(row.prompt_bundle) as PromptBundle)
      : undefined,
  };
}

export interface CreateSegmentInput {
  projectId: string;
  order: number;
  sourceText: string;
  sceneSummary: string;
  characterNames: string[];
  emotion: string;
  estimatedSeconds: number;
}

export function createSegment(db: DatabaseSync, input: CreateSegmentInput): Segment {
  const segment: Segment = {
    id: randomUUID(),
    projectId: input.projectId,
    order: input.order,
    sourceText: input.sourceText,
    sceneSummary: input.sceneSummary,
    characterNames: input.characterNames,
    emotion: input.emotion,
    estimatedSeconds: input.estimatedSeconds,
    status: 'draft',
    currentVersion: 1,
  };
  db.prepare(
    `INSERT INTO video_segments
       (id, project_id, seq_order, source_text, scene_summary,
        character_names, emotion, estimated_seconds, status, current_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    segment.id,
    segment.projectId,
    segment.order,
    segment.sourceText,
    segment.sceneSummary,
    JSON.stringify(segment.characterNames),
    segment.emotion,
    segment.estimatedSeconds,
    segment.status,
    segment.currentVersion,
  );
  return segment;
}

export function getSegment(db: DatabaseSync, id: string): Segment | undefined {
  const row = db.prepare('SELECT * FROM video_segments WHERE id = ?').get(id) as
    | SegmentRow
    | undefined;
  return row ? rowToSegment(row) : undefined;
}

export function listSegmentsByProject(db: DatabaseSync, projectId: string): Segment[] {
  const rows = db
    .prepare('SELECT * FROM video_segments WHERE project_id = ? ORDER BY seq_order ASC')
    .all(projectId) as unknown as SegmentRow[];
  return rows.map(rowToSegment);
}

/** 批量替换项目分镜（拆分阶段整组写入，事务保证原子性）。 */
export function replaceProjectSegments(
  db: DatabaseSync,
  projectId: string,
  inputs: CreateSegmentInput[],
): Segment[] {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM video_segments WHERE project_id = ?').run(projectId);
    const created = inputs.map((input) => createSegment(db, input));
    db.exec('COMMIT');
    return created;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface UpdateSegmentFields {
  sceneSummary?: string;
  characterNames?: string[];
  emotion?: string;
  estimatedSeconds?: number;
  prompt?: PromptBundle;
}

export function updateSegment(
  db: DatabaseSync,
  id: string,
  fields: UpdateSegmentFields,
): Segment | undefined {
  const existing = getSegment(db, id);
  if (!existing) return undefined;
  const next: Segment = { ...existing, ...fields };
  db.prepare(
    `UPDATE video_segments
       SET scene_summary = ?, character_names = ?, emotion = ?,
           estimated_seconds = ?, prompt_bundle = ?
     WHERE id = ?`,
  ).run(
    next.sceneSummary,
    JSON.stringify(next.characterNames),
    next.emotion,
    next.estimatedSeconds,
    next.prompt ? JSON.stringify(next.prompt) : null,
    id,
  );
  return next;
}

/** 分镜状态流转：必须经 SEGMENT_TRANSITIONS 校验，非法流转抛错。 */
export function transitionSegmentStatus(
  db: DatabaseSync,
  id: string,
  to: SegmentStatus,
): Segment {
  const existing = getSegment(db, id);
  if (!existing) {
    throw new Error(`segment not found: ${id}`);
  }
  if (existing.status === to) return existing;
  if (!canSegmentTransition(existing.status, to)) {
    throw new Error(`illegal segment status transition: ${existing.status} -> ${to}`);
  }
  db.prepare('UPDATE video_segments SET status = ? WHERE id = ?').run(to, id);
  return { ...existing, status: to };
}

export interface SegmentVersionRecord {
  id: string;
  segmentId: string;
  version: number;
  prompt?: PromptBundle;
  videoPath?: string;
  audioPath?: string;
  createdAt: string;
}

/** 写入版本快照（video_segment_versions），segment_id + version 唯一。 */
export function insertSegmentVersion(
  db: DatabaseSync,
  input: Omit<SegmentVersionRecord, 'id' | 'createdAt'>,
): SegmentVersionRecord {
  const record: SegmentVersionRecord = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO video_segment_versions
       (id, segment_id, version, prompt_bundle, video_path, audio_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.segmentId,
    record.version,
    record.prompt ? JSON.stringify(record.prompt) : null,
    record.videoPath ?? null,
    record.audioPath ?? null,
    record.createdAt,
  );
  return record;
}

export function listSegmentVersions(
  db: DatabaseSync,
  segmentId: string,
): SegmentVersionRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM video_segment_versions WHERE segment_id = ? ORDER BY version ASC',
    )
    .all(segmentId) as Array<{
      id: string;
      segment_id: string;
      version: number;
      prompt_bundle: string | null;
      video_path: string | null;
      audio_path: string | null;
      created_at: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    segmentId: row.segment_id,
    version: row.version,
    prompt: row.prompt_bundle ? (JSON.parse(row.prompt_bundle) as PromptBundle) : undefined,
    videoPath: row.video_path ?? undefined,
    audioPath: row.audio_path ?? undefined,
    createdAt: row.created_at,
  }));
}
