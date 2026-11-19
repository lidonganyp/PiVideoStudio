import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getSegment, updateJob, listJobsByProject } from '../store';
import type { Segment } from '../types';

const execFileAsync = promisify(execFile);

/**
 * 自动 QC 三级分流（v1.1）：
 * - approved：高置信自动通过（无 issue）
 * - suspect：低置信问题，进入人工抽检池（10~20%）
 * - rejected：明确失败，驳回回流重生成
 *
 * 初期策略（阈值宽松）：
 * - 只做确定性元数据检查（ffprobe 时长/分辨率/文件完整性）
 * - 手部/唇形/角色一致性/灯光等视觉检查留 LLM 钩子
 *   （QC_VISION_LLM=true 且 LLM 网关支持视觉输入时启用），
 *   未启用时一律不因此驳回，最多标 suspect
 * - ENABLE_AUTO_QC=false 默认关闭，联调稳定后开启
 */

export type QCVerdict = 'approved' | 'suspect' | 'rejected';

export interface QCIssue {
  /** 检查项：duration/resolution/file/vision */
  check: string;
  /** 问题描述 */
  message: string;
  /** 置信度 0~1，越高越可信 */
  confidence: number;
}

export interface QCReport {
  verdict: QCVerdict;
  issues: QCIssue[];
  /** 是否进入人工抽检池 */
  needsHumanReview: boolean;
  checkedAt: string;
}

/** 自动 QC 是否启用 */
export function isAutoQCEnabled(): boolean {
  return process.env.ENABLE_AUTO_QC === 'true';
}

/** 视觉 LLM 检查是否启用（手部/唇形/角色一致性/灯光） */
function isVisionLLMEnabled(): boolean {
  return process.env.QC_VISION_LLM === 'true';
}

/** 人工抽检比例（0~1），默认 0.2（20%） */
function humanSampleRate(): number {
  const rate = Number(process.env.QC_HUMAN_SAMPLE_RATE ?? '0.2');
  if (Number.isNaN(rate) || rate < 0 || rate > 1) return 0.2;
  return rate;
}

/**
 * 确定性人工抽检：以 segmentId 哈希为种子，保证同一块多次 QC 结论稳定。
 * 命中率约等于 humanSampleRate。
 */
export function shouldSampleForHumanReview(segmentId: string): boolean {
  const hash = createHash('sha256').update(segmentId).digest();
  const bucket = hash.readUInt16BE(0) % 10_000; // 0~9999
  return bucket < Math.round(humanSampleRate() * 10_000);
}

interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
}

async function probeVideo(videoPath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    videoPath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  return {
    durationSeconds: Number(data.format?.duration ?? 0),
    width: data.streams?.[0]?.width ?? 0,
    height: data.streams?.[0]?.height ?? 0,
  };
}

/**
 * 对单个叙事块视频执行自动 QC。
 * @param segment 目标块
 * @param videoPath 已落盘的视频文件路径
 * @returns QC 报告（verdict + issues + 是否需人工抽检）
 */
export async function runQC(
  segment: Segment,
  videoPath: string,
): Promise<QCReport> {
  const issues: QCIssue[] = [];
  const checkedAt = new Date().toISOString();

  // 1. 文件完整性
  if (!existsSync(videoPath)) {
    return {
      verdict: 'rejected',
      issues: [{ check: 'file', message: `视频文件不存在: ${videoPath}`, confidence: 1 }],
      needsHumanReview: false,
      checkedAt,
    };
  }

  // 2. 元数据检查（ffprobe）
  let probe: ProbeResult | undefined;
  try {
    probe = await probeVideo(videoPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: 'rejected',
      issues: [{ check: 'file', message: `ffprobe 解析失败（文件可能损坏）: ${message}`, confidence: 0.9 }],
      needsHumanReview: false,
      checkedAt,
    };
  }

  // 3. 时长偏差：与预估偏差 >40% 标 suspect（阈值宽松）
  const expected = segment.estimatedSeconds;
  if (expected > 0 && probe.durationSeconds > 0) {
    const deviation = Math.abs(probe.durationSeconds - expected) / expected;
    if (deviation > 0.4) {
      issues.push({
        check: 'duration',
        message: `时长偏差 ${(deviation * 100).toFixed(1)}%（实际 ${probe.durationSeconds.toFixed(1)}s / 预估 ${expected}s）`,
        confidence: 0.6,
      });
    }
  }

  // 4. 分辨率下限：低于 720p 标 suspect
  if (probe.height > 0 && probe.height < 720) {
    issues.push({
      check: 'resolution',
      message: `分辨率 ${probe.width}x${probe.height} 低于 720p`,
      confidence: 0.7,
    });
  }

  // 5. 视觉 LLM 钩子（手部/唇形/角色一致性/灯光/首尾帧衔接）
  //    初期未启用：这些检查项不产生 issue，避免误判驳回。
  //    启用后由 LLM 网关的视觉模型输出结构化 issue（后续改造接入）。
  if (isVisionLLMEnabled()) {
    // TODO: 接入视觉 LLM 检查（手部数量/唇形同步/角色一致性/灯光连续性）
    // 初期占位：视觉检查结果仅标 suspect，不直接驳回
  }

  // 三级分流：
  // - 无 issue → approved
  // - 高置信 issue（confidence >= 0.85）→ rejected（初期阈值宽松，元数据检查很难达到 0.85，实际仅文件损坏会驳回）
  // - 其余 → suspect
  let verdict: QCVerdict = 'approved';
  if (issues.length > 0) {
    const hasHighConfidence = issues.some((i) => i.confidence >= 0.85);
    verdict = hasHighConfidence ? 'rejected' : 'suspect';
  }

  // 人工抽检：suspect 必检；approved 按比例抽检
  const needsHumanReview =
    verdict === 'suspect' ||
    (verdict === 'approved' && shouldSampleForHumanReview(segment.id));

  return { verdict, issues, needsHumanReview, checkedAt };
}

/**
 * 将 QC 报告写入该块最近一次视频生成 job 的 qcResult 字段。
 * 找不到对应 job 时静默跳过（QC 结果仅作标注，不阻断流程）。
 */
export function persistQCResult(
  db: DatabaseSync,
  segmentId: string,
  report: QCReport,
): void {
  const segment = getSegment(db, segmentId);
  if (!segment) return;
  const jobs = listJobsByProject(db, segment.projectId)
    .filter((j) => j.segmentId === segmentId && j.status === 'succeeded')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = jobs[0];
  if (!latest) return;
  updateJob(db, latest.id, { qcResult: report.verdict });
}
