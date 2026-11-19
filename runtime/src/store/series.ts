import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Series } from '../types';

interface SeriesRow {
  id: string;
  title: string;
  novel_project_id: string | null;
  episode_count: number;
  story_bible: string | null;
  created_at: string;
}

function rowToSeries(row: SeriesRow): Series {
  return {
    id: row.id,
    title: row.title,
    novelProjectId: row.novel_project_id ?? undefined,
    episodeCount: row.episode_count,
    storyBible: row.story_bible ?? undefined,
    createdAt: row.created_at,
  };
}

export interface CreateSeriesInput {
  title: string;
  novelProjectId?: string;
  episodeCount?: number;
  storyBible?: string;
}

export function createSeries(db: DatabaseSync, input: CreateSeriesInput): Series {
  const now = new Date().toISOString();
  const series: Series = {
    id: randomUUID(),
    title: input.title,
    novelProjectId: input.novelProjectId,
    episodeCount: input.episodeCount ?? 0,
    storyBible: input.storyBible,
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO series (id, title, novel_project_id, episode_count, story_bible, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    series.id,
    series.title,
    series.novelProjectId ?? null,
    series.episodeCount,
    series.storyBible ?? null,
    series.createdAt,
  );
  return series;
}

export function getSeries(db: DatabaseSync, id: string): Series | undefined {
  const row = db.prepare('SELECT * FROM series WHERE id = ?').get(id) as
    | SeriesRow
    | undefined;
  return row ? rowToSeries(row) : undefined;
}

export function listSeries(db: DatabaseSync): Series[] {
  const rows = db
    .prepare('SELECT * FROM series ORDER BY created_at DESC')
    .all() as unknown as SeriesRow[];
  return rows.map(rowToSeries);
}

export interface UpdateSeriesFields {
  title?: string;
  episodeCount?: number;
  storyBible?: string;
}

export function updateSeries(
  db: DatabaseSync,
  id: string,
  fields: UpdateSeriesFields,
): Series | undefined {
  const existing = getSeries(db, id);
  if (!existing) return undefined;
  const next: Series = { ...existing, ...fields };
  db.prepare(
    `UPDATE series
       SET title = ?, episode_count = ?, story_bible = ?
     WHERE id = ?`,
  ).run(next.title, next.episodeCount, next.storyBible ?? null, id);
  return next;
}
