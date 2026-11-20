import type { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STORAGE_DIR } from '../storage';
import { listSegmentsByProject } from '../store';
import type { Segment } from '../types';

const execFileAsync = promisify(execFile);

/**
 * 首帧链（v1.1）：上一块的尾帧作为下一块的首帧参考，
 * 消除跨片段的画面漂移（角色/场景/灯光跳变）。
 *
 * 链路：视频生成成功 → ffmpeg 抽尾帧存
 * storage/videos/{segmentId}/segment-{segmentId}-lastframe.png
 * → 下一块提交时作为 firstFramePath 传入 Provider（i2v 首帧模式）。
 *
 * 断链规则：场景切换（相邻块 sceneSummary 不同）时断链，
 * 避免把上一场的画面错误延续到新场景。
 *
 * 联调期默认关闭（ENABLE_FIRST_FRAME_CHAIN=false），
 * 因首帧参数与各 Provider 的实际兼容性需逐一验证后再开启。
 */

/** 首帧链是否启用 */
export function isFirstFrameChainEnabled(): boolean {
  return process.env.ENABLE_FIRST_FRAME_CHAIN === 'true';
}

/** 尾帧图路径：storage/videos/{segmentId}/segment-{segmentId}-lastframe.png */
export function lastFramePath(segmentId: string): string {
  return resolve(
    STORAGE_DIR,
    'videos',
    segmentId,
    `segment-${segmentId}-lastframe.png`,
  );
}

/**
 * 抽取视频最后一帧并存盘，返回尾帧图路径。
 * 使用 -sseof -0.1 从文件末尾前 0.1s 定位，取 1 帧输出 PNG。
 */
export async function extractLastFrame(
  videoPath: string,
  segmentId: string,
): Promise<string> {
  const outPath = lastFramePath(segmentId);
  await execFileAsync('ffmpeg', [
    '-y',
    '-sseof',
    '-0.1',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    outPath,
  ]);
  return outPath;
}

/**
 * 获取当前块的首帧参考图路径（上一块的尾帧）。
 * 返回 undefined 的情形（均视为断链/不启用）：
 * - 首帧链开关关闭
 * - 第一块（order = 1）
 * - 上一块不存在
 * - 上一块尾帧图尚未生成（前块未完成或抽取失败）
 * - 场景切换：相邻块 sceneSummary 不同（初版用全等判断，
 *   后续可升级为场景圣经 name 匹配）
 */
export function getFirstFrameRef(
  db: DatabaseSync,
  segment: Segment,
): string | undefined {
  if (!isFirstFrameChainEnabled()) return undefined;
  if (segment.order <= 1) return undefined;
  const segments = listSegmentsByProject(db, segment.projectId);
  const prev = segments.find((s) => s.order === segment.order - 1);
  if (!prev) return undefined;
  // v1.1.2：断链判据从 sceneSummary 全等改为角色重叠（sceneSummary 是事件描述，
  // 同场景各块必然不同，旧判据导致同场景首帧链全断）；无共同角色视为场景切换
  const prevChars = new Set(prev.characterNames ?? []);
  const hasShared = (segment.characterNames ?? []).some((c) => prevChars.has(c));
  if (!hasShared) {
    return undefined; // 场景切换断链（无共同出场角色）
  }
  const framePath = lastFramePath(prev.id);
  return existsSync(framePath) ? framePath : undefined;
}
