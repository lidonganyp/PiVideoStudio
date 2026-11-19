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

    CREATE TABLE IF NOT EXISTS series (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      novel_project_id TEXT,
      episode_count    INTEGER NOT NULL DEFAULT 0,
      story_bible      TEXT,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_assets (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'library',
      license     TEXT NOT NULL DEFAULT 'licensed',
      has_ip_risk INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
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

  // 幂等列迁移：v1.1 叙事块扩展字段（shots/shot_class/axis_lock/prompt_v2）
  const v11SegmentColumns = db
    .prepare("PRAGMA table_info(video_segments)")
    .all() as Array<{ name: string }>;
  const v11Existing = new Set(v11SegmentColumns.map((c) => c.name));
  const v11Additions: Array<[string, string]> = [
    ['shots', 'TEXT'], // JSON: ShotPlan[]（30s 叙事块内按秒分镜）
    ['shot_class', 'TEXT'], // 模型路由标注（ShotClass）
    ['axis_lock', 'TEXT'], // 轴线锁定声明
    ['prompt_v2', 'TEXT'], // JSON: PromptBundleV2（12 模块提示词）
  ];
  for (const [column, ddl] of v11Additions) {
    if (!v11Existing.has(column)) {
      db.exec(`ALTER TABLE video_segments ADD COLUMN ${column} ${ddl}`);
    }
  }

  // 幂等列迁移：video_assets 候选参考图字段
  const assetColumns = db
    .prepare("PRAGMA table_info(video_assets)")
    .all() as Array<{ name: string }>;
  const assetExisting = new Set(assetColumns.map((c) => c.name));
  if (!assetExisting.has('candidate_images')) {
    db.exec(
      "ALTER TABLE video_assets ADD COLUMN candidate_images TEXT NOT NULL DEFAULT '[]'",
    );
  }

  // 幂等列迁移：v1.1 资产圣经扩展字段（scope/variant_of/lighting_spec/audio_spec/voice_id）
  const v11AssetAdditions: Array<[string, string]> = [
    ['scope', "TEXT NOT NULL DEFAULT 'project'"], // series=剧集级共享 / project=集级
    ['variant_of', 'TEXT'], // wardrobe variant：指向主角色卡 ID
    ['lighting_spec', 'TEXT'], // 场景灯光规格（色温/方向数值化）
    ['audio_spec', 'TEXT'], // 场景声音规格
    ['voice_id', 'TEXT'], // 角色音色绑定（Voice Registry）
  ];
  for (const [column, ddl] of v11AssetAdditions) {
    if (!assetExisting.has(column)) {
      db.exec(`ALTER TABLE video_assets ADD COLUMN ${column} ${ddl}`);
    }
  }

  // 幂等列迁移：v1.1 队列优先级（2=人工确认 regenerate / 1=失败重试 / 0=批量生成）
  const jobColumns = db
    .prepare("PRAGMA table_info(video_jobs)")
    .all() as Array<{ name: string }>;
  const jobExisting = new Set(jobColumns.map((c) => c.name));
  if (!jobExisting.has('priority')) {
    db.exec('ALTER TABLE video_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobExisting.has('qc_result')) {
    db.exec("ALTER TABLE video_jobs ADD COLUMN qc_result TEXT CHECK (qc_result IN ('approved', 'suspect', 'rejected'))");
  }
  if (!jobExisting.has('provider_model')) {
    db.exec('ALTER TABLE video_jobs ADD COLUMN provider_model TEXT');
  }
}
