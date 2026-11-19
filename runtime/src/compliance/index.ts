/**
 * 合规存储（v1.1）：
 * 1. 剧本层内容安全前置审核（LLM 钩子，ENABLE_CONTENT_SAFETY=true 时启用）
 * 2. 音乐 non-IP 落库（记录音乐来源/授权状态）
 * 3. 只留最终版+最近草稿（清理过期中间版本与临时文件）
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { STORAGE_DIR } from '../storage';
import { callLLMAsJSON } from '../llm/gateway';
import { listSegmentVersions } from '../store';
import type { Screenplay } from '../types';

/** 内容安全审核结果 */
export interface ContentSafetyResult {
  passed: boolean;
  /** 风险标签：violence/nudity/political/illegal/none */
  riskTag: string;
  /** 风险描述 */
  detail: string;
}

/** 内容安全是否启用 */
export function isContentSafetyEnabled(): boolean {
  return process.env.ENABLE_CONTENT_SAFETY === 'true';
}

const SAFETY_SYSTEM_PROMPT = `你是内容安全审核员。审核剧本内容是否存在以下风险：
1. 暴力血腥（过度描写暴力行为）
2. 色情低俗（性暗示/裸露描写）
3. 政治敏感（涉及政治人物/事件/立场）
4. 违法犯罪（教唆/美化犯罪行为）
如果没有以上风险，返回 passed=true, riskTag="none"。
输出 JSON：{ passed: boolean, riskTag: string, detail: string }`;

/**
 * 剧本层内容安全前置审核（v1.1）。
 * 在剧本化改写后、拆分前调用，拦截高风险内容。
 * 未启用时直接返回 passed=true。
 */
export async function checkScreenplaySafety(
  screenplay: Screenplay,
): Promise<ContentSafetyResult> {
  if (!isContentSafetyEnabled()) {
    return { passed: true, riskTag: 'none', detail: '内容安全审核未启用' };
  }
  const content = screenplay.scenes.map((s) => s.content).join('\n---\n');
  try {
    const result = await callLLMAsJSON<ContentSafetyResult>({
      system: SAFETY_SYSTEM_PROMPT,
      user: `请审核以下剧本内容：\n${content}`,
    });
    return {
      passed: result.passed ?? false,
      riskTag: result.riskTag ?? 'unknown',
      detail: result.detail ?? '',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[compliance] 内容安全审核失败（放行但标记）：${message}`);
    return { passed: true, riskTag: 'unknown', detail: `审核服务异常：${message}` };
  }
}

/** 音乐资产记录 */
export interface MusicAsset {
  id: string;
  projectId: string;
  /** 音乐文件名 */
  filename: string;
  /** 来源：original/library/stock */
  source: string;
  /** 授权状态：licensed/public_domain/unknown */
  license: string;
  /** 是否 IP 风险 */
  hasIpRisk: boolean;
}

/**
 * 注册音乐资产（non-IP 落库）。
 * 在 composer 合成后调用，记录使用的背景音乐来源与授权状态。
 */
export function registerMusicAsset(
  db: DatabaseSync,
  projectId: string,
  filename: string,
  source: string = 'library',
  license: string = 'licensed',
): MusicAsset {
  const id = `music-${projectId}-${Date.now()}`;
  const hasIpRisk = source === 'unknown' || license === 'unknown';
  db.prepare(
    `INSERT OR IGNORE INTO music_assets (id, project_id, filename, source, license, has_ip_risk)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, filename, source, license, hasIpRisk ? 1 : 0);
  console.log(`[compliance] 音乐资产注册：${filename} source=${source} license=${license} ipRisk=${hasIpRisk}`);
  return { id, projectId, filename, source, license, hasIpRisk };
}

/**
 * 清理合成临时文件（v1.1）。
 * composer 合成过程中产生的 *_tmp.mp4 和 concat 文件在最终输出后应清理。
 */
export function cleanupTempFiles(outputDir: string): { removed: string[] } {
  const removed: string[] = [];
  if (!existsSync(outputDir)) return { removed };
  const files = readdirSync(outputDir);
  for (const file of files) {
    if (file.endsWith('_tmp.mp4') || file.endsWith('.concat.txt')) {
      const fullPath = resolve(outputDir, file);
      try {
        unlinkSync(fullPath);
        removed.push(file);
      } catch {
        // 忽略删除失败
      }
    }
  }
  if (removed.length > 0) {
    console.log(`[compliance] 清理临时文件：${removed.join(', ')}`);
  }
  return { removed };
}

/**
 * 版本保留策略（v1.1）：只留最终版+最近草稿。
 * 清理 segment 的过期中间版本视频文件（保留 currentVersion 和 currentVersion-1）。
 */
export function pruneSegmentVersions(
  db: DatabaseSync,
  segmentId: string,
): { pruned: string[] } {
  const versions = listSegmentVersions(db, segmentId);
  if (versions.length <= 2) return { pruned: [] };
  // 按版本号降序，保留最新两个
  const sorted = versions.sort((a, b) => b.version - a.version);
  const toRemove = sorted.slice(2);
  const pruned: string[] = [];
  const videoDir = resolve(STORAGE_DIR, 'videos', segmentId);
  for (const v of toRemove) {
    const videoPath = resolve(videoDir, `v${v.version}.mp4`);
    if (existsSync(videoPath)) {
      try {
        unlinkSync(videoPath);
        pruned.push(`v${v.version}.mp4`);
      } catch {
        // 忽略删除失败
      }
    }
  }
  if (pruned.length > 0) {
    console.log(`[compliance] 版本清理 segment=${segmentId}：删除 ${pruned.join(', ')}`);
  }
  return { pruned };
}
