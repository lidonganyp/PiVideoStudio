import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AspectRatio, ProjectStatus, StyleTemplate, VideoProject } from '../types';
import { canTransition } from '../state-machine';

interface ProjectRow {
  id: string;
  title: string;
  owner_user_id: number | null;
  novel_source: string;
  style: string;
  aspect_ratio: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): VideoProject {
  return {
    id: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id ?? undefined,
    novelSource: JSON.parse(row.novel_source) as VideoProject['novelSource'],
    style: row.style as StyleTemplate,
    aspectRatio: row.aspect_ratio as AspectRatio,
    status: row.status as ProjectStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProjectInput {
  title: string;
  novelSource: VideoProject['novelSource'];
  style: StyleTemplate;
  aspectRatio: AspectRatio;
  /** 项目归属（PiNovelStudio 用户 ID，B7 融合） */
  ownerUserId?: number;
}

export function createProject(db: DatabaseSync, input: CreateProjectInput): VideoProject {
  const now = new Date().toISOString();
  const project: VideoProject = {
    id: randomUUID(),
    title: input.title,
    ownerUserId: input.ownerUserId,
    novelSource: input.novelSource,
    style: input.style,
    aspectRatio: input.aspectRatio,
    status: 'planning',
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO video_projects
       (id, title, owner_user_id, novel_source, style, aspect_ratio, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.title,
    project.ownerUserId ?? null,
    JSON.stringify(project.novelSource),
    project.style,
    project.aspectRatio,
    project.status,
    project.createdAt,
    project.updatedAt,
  );
  return project;
}

export function getProject(db: DatabaseSync, id: string): VideoProject | undefined {
  const row = db.prepare('SELECT * FROM video_projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row ? rowToProject(row) : undefined;
}

export function listProjects(db: DatabaseSync, ownerUserId?: number): VideoProject[] {
  const rows =
    ownerUserId === undefined
      ? (db
          .prepare('SELECT * FROM video_projects ORDER BY created_at DESC')
          .all() as unknown as ProjectRow[])
      : (db
          .prepare(
            'SELECT * FROM video_projects WHERE owner_user_id = ? ORDER BY created_at DESC',
          )
          .all(ownerUserId) as unknown as ProjectRow[]);
  return rows.map(rowToProject);
}

export interface UpdateProjectFields {
  title?: string;
  novelSource?: VideoProject['novelSource'];
  style?: StyleTemplate;
  aspectRatio?: AspectRatio;
}

/** 通用字段更新（不含状态），自动维护 updated_at。 */
export function updateProject(
  db: DatabaseSync,
  id: string,
  fields: UpdateProjectFields,
): VideoProject | undefined {
  const existing = getProject(db, id);
  if (!existing) return undefined;
  const next: VideoProject = {
    ...existing,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE video_projects
       SET title = ?, novel_source = ?, style = ?, aspect_ratio = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.title,
    JSON.stringify(next.novelSource),
    next.style,
    next.aspectRatio,
    next.updatedAt,
    id,
  );
  return next;
}

/**
 * 状态流转：必须经 runtime/src/state-machine.ts 校验，非法流转抛错。
 */
export function transitionProjectStatus(
  db: DatabaseSync,
  id: string,
  to: ProjectStatus,
): VideoProject {
  const existing = getProject(db, id);
  if (!existing) {
    throw new Error(`project not found: ${id}`);
  }
  if (existing.status === to) return existing;
  if (!canTransition(existing.status, to)) {
    throw new Error(`illegal project status transition: ${existing.status} -> ${to}`);
  }
  const updatedAt = new Date().toISOString();
  db.prepare('UPDATE video_projects SET status = ?, updated_at = ? WHERE id = ?').run(
    to,
    updatedAt,
    id,
  );
  return { ...existing, status: to, updatedAt };
}
