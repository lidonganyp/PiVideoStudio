import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 数据库文件默认落在仓库根 storage/pivideo.db（.gitignore 已排除 storage/）。
 * 可用环境变量 PIVIDEO_DB_PATH 覆盖（api / worker 共用同一份数据）。
 */
const DEFAULT_DB_PATH = resolve(
  fileURLToPath(new URL('../../../storage/pivideo.db', import.meta.url)),
);

export function resolveDbPath(): string {
  return process.env.PIVIDEO_DB_PATH ?? DEFAULT_DB_PATH;
}

export function openDb(dbPath: string = resolveDbPath()): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * 服务启动时自动建表（幂等）。
 * 表结构说明见 docs/development-tasks.md T-01；字段变更必须同步更新该文档。
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_projects (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      novel_source TEXT NOT NULL DEFAULT '{}',
      style        TEXT NOT NULL DEFAULT 'narration',
      aspect_ratio TEXT NOT NULL DEFAULT '9:16',
      status       TEXT NOT NULL DEFAULT 'planning',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS video_segments (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      seq_order         INTEGER NOT NULL,
      source_text       TEXT NOT NULL,
      scene_summary     TEXT NOT NULL DEFAULT '',
      character_names   TEXT NOT NULL DEFAULT '[]',
      emotion           TEXT NOT NULL DEFAULT '',
      estimated_seconds REAL NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'draft',
      current_version   INTEGER NOT NULL DEFAULT 1,
      prompt_bundle      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_segments_project
      ON video_segments(project_id, seq_order);

    CREATE TABLE IF NOT EXISTS video_segment_versions (
      id            TEXT PRIMARY KEY,
      segment_id    TEXT NOT NULL REFERENCES video_segments(id) ON DELETE CASCADE,
      version       INTEGER NOT NULL,
      prompt_bundle TEXT,
      video_path    TEXT,
      audio_path    TEXT,
      created_at    TEXT NOT NULL,
      UNIQUE(segment_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_video_segment_versions_segment
      ON video_segment_versions(segment_id, version);

    CREATE TABLE IF NOT EXISTS video_assets (
      id                   TEXT PRIMARY KEY,
      project_id           TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      kind                 TEXT NOT NULL CHECK (kind IN ('character', 'scene')),
      name                 TEXT NOT NULL,
      description          TEXT NOT NULL DEFAULT '',
      reference_image_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_assets_project
      ON video_assets(project_id, kind);

    CREATE TABLE IF NOT EXISTS video_jobs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      segment_id      TEXT REFERENCES video_segments(id) ON DELETE SET NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('t2i', 'i2v', 't2v', 'tts', 'compose')),
      provider        TEXT NOT NULL,
      provider_job_id TEXT,
      status          TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      retry_count     INTEGER NOT NULL DEFAULT 0,
      result_path     TEXT,
      error           TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_video_jobs_project ON video_jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status);
  `);

  // 幂等列迁移：场景切片扩展字段（event/character_state/next_scene_hint）
  const segmentColumns = db
    .prepare("PRAGMA table_info(video_segments)")
    .all() as Array<{ name: string }>;
  const existing = new Set(segmentColumns.map((c) => c.name));
  const additions: Array<[string, string]> = [
    ['event', "TEXT NOT NULL DEFAULT ''"],
    ['character_state', "TEXT NOT NULL DEFAULT ''"],
    ['next_scene_hint', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, ddl] of additions) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE video_segments ADD COLUMN ${column} ${ddl}`);
    }
  }
}
