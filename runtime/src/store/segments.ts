import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  PromptBundle,
  PromptBundleV2,
  Segment,
  SegmentStatus,
  ShotPlan,
} from '../types';
import type { ShotClass } from '../providers/router';
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
  event: string;
  character_state: string;
  next_scene_hint: string;
  status: string;
  current_version: number;
  prompt_bundle: string | null;
  shots: string | null;
  shot_class: string | null;
  axis_lock: string | null;
  prompt_v2: string | null;
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
    event: row.event ?? '',
    characterState: row.character_state ?? '',
    nextSceneHint: row.next_scene_hint ?? '',
    status: row.status as SegmentStatus,
    currentVersion: row.current_version,
    prompt: row.prompt_bundle
      ? (JSON.parse(row.prompt_bundle) as PromptBundle)
      : undefined,
    shots: row.shots ? (JSON.parse(row.shots) as ShotPlan[]) : undefined,
    shotClass: (row.shot_class as ShotClass | null) ?? undefined,
    axisLock: row.axis_lock ?? undefined,
    promptV2: row.prompt_v2
      ? (JSON.parse(row.prompt_v2) as PromptBundleV2)
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
  event?: string;
  characterState?: string;
  nextSceneHint?: string;
  /** v1.1：30s 叙事块内按秒分镜 */
  shots?: ShotPlan[];
  /** v1.1：模型路由标注 */
  shotClass?: ShotClass;
  /** v1.1：轴线锁定声明 */
  axisLock?: string;
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
    event: input.event ?? '',
    characterState: input.characterState ?? '',
    nextSceneHint: input.nextSceneHint ?? '',
    status: 'draft',
    currentVersion: 1,
    shots: input.shots,
    shotClass: input.shotClass,
    axisLock: input.axisLock,
  };
  db.prepare(
    `INSERT INTO video_segments
       (id, project_id, seq_order, source_text, scene_summary,
        character_names, emotion, estimated_seconds,
        event, character_state, next_scene_hint,
        status, current_version, shots, shot_class, axis_lock)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    segment.id,
    segment.projectId,
    segment.order,
    segment.sourceText,
    segment.sceneSummary,
    JSON.stringify(segment.characterNames),
    segment.emotion,
    segment.estimatedSeconds,
    segment.event,
    segment.characterState,
    segment.nextSceneHint,
    segment.status,
    segment.currentVersion,
    segment.shots ? JSON.stringify(segment.shots) : null,
    segment.shotClass ?? null,
    segment.axisLock ?? null,
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
  event?: string;
  characterState?: string;
  nextSceneHint?: string;
  prompt?: PromptBundle;
  /** v1.1 */
  shots?: ShotPlan[];
  shotClass?: ShotClass;
  axisLock?: string;
  promptV2?: PromptBundleV2;
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
           estimated_seconds = ?, event = ?, character_state = ?,
           next_scene_hint = ?, prompt_bundle = ?,
           shots = ?, shot_class = ?, axis_lock = ?, prompt_v2 = ?
     WHERE id = ?`,
  ).run(
    next.sceneSummary,
    JSON.stringify(next.characterNames),
    next.emotion,
    next.estimatedSeconds,
    next.event,
    next.characterState,
    next.nextSceneHint,
    next.prompt ? JSON.stringify(next.prompt) : null,
    next.shots ? JSON.stringify(next.shots) : null,
    next.shotClass ?? null,
    next.axisLock ?? null,
    next.promptV2 ? JSON.stringify(next.promptV2) : null,
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
