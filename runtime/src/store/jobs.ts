import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { JobKind, VideoJob } from '../types';

export type JobStatus = VideoJob['status'];

interface JobRow {
  id: string;
  project_id: string;
  segment_id: string | null;
  kind: string;
  provider: string;
  provider_job_id: string | null;
  status: string;
  retry_count: number;
  result_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: JobRow): VideoJob {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id ?? undefined,
    kind: row.kind as JobKind,
    provider: row.provider,
    providerJobId: row.provider_job_id ?? undefined,
    status: row.status as JobStatus,
    retryCount: row.retry_count,
    resultPath: row.result_path ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateJobInput {
  projectId: string;
  segmentId?: string;
  kind: JobKind;
  provider: string;
  providerJobId?: string;
}

export function createJob(db: DatabaseSync, input: CreateJobInput): VideoJob {
  const now = new Date().toISOString();
  const job: VideoJob = {
    id: randomUUID(),
    projectId: input.projectId,
    segmentId: input.segmentId,
    kind: input.kind,
    provider: input.provider,
    providerJobId: input.providerJobId,
    status: 'queued',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO video_jobs
       (id, project_id, segment_id, kind, provider, provider_job_id,
        status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.projectId,
    job.segmentId ?? null,
    job.kind,
    job.provider,
    job.providerJobId ?? null,
    job.status,
    job.retryCount,
    job.createdAt,
    job.updatedAt,
  );
  return job;
}

export function getJob(db: DatabaseSync, id: string): VideoJob | undefined {
  const row = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as
    | JobRow
    | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listJobsByProject(db: DatabaseSync, projectId: string): VideoJob[] {
  const rows = db
    .prepare('SELECT * FROM video_jobs WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as unknown as JobRow[];
  return rows.map(rowToJob);
}

export function listJobsByStatus(db: DatabaseSync, status: JobStatus): VideoJob[] {
  const rows = db
    .prepare('SELECT * FROM video_jobs WHERE status = ? ORDER BY created_at ASC')
    .all(status) as unknown as JobRow[];
  return rows.map(rowToJob);
}

export interface UpdateJobFields {
  providerJobId?: string;
  status?: JobStatus;
  retryCount?: number;
  resultPath?: string;
  error?: string;
}

/** 更新任务字段，自动维护 updated_at。 */
export function updateJob(
  db: DatabaseSync,
  id: string,
  fields: UpdateJobFields,
): VideoJob | undefined {
  const existing = getJob(db, id);
  if (!existing) return undefined;
  const next: VideoJob = {
    ...existing,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE video_jobs
       SET provider_job_id = ?, status = ?, retry_count = ?,
           result_path = ?, error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.providerJobId ?? null,
    next.status,
    next.retryCount,
    next.resultPath ?? null,
    next.error ?? null,
    next.updatedAt,
    id,
  );
  return next;
}
