import type { ProjectStatus, SegmentStatus } from './types';

/** 项目状态机：九阶段流水线的合法流转 */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  planning: ['splitting', 'asset_extracting', 'prompt_building', 'segment_generating', 'failed'],
  splitting: ['planning', 'asset_extracting', 'failed'],
  asset_extracting: ['planning', 'prompt_building', 'failed'],
  prompt_building: ['planning', 'reference_generating', 'segment_generating', 'failed'],
  reference_generating: ['segment_generating', 'failed'],
  segment_generating: ['reviewing', 'composing', 'failed'],
  reviewing: ['segment_generating', 'composing', 'planning'], // 审核不通过回流重生成
  composing: ['delivering', 'planning', 'failed'],
  delivering: ['done', 'failed'],
  done: [],
  failed: [],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return (PROJECT_TRANSITIONS[from] ?? []).includes(to);
}

export function canSegmentTransition(from: SegmentStatus, to: SegmentStatus): boolean {
  return (SEGMENT_TRANSITIONS[from] ?? []).includes(to);
}

/** 分镜状态机 */
export const SEGMENT_TRANSITIONS: Record<SegmentStatus, SegmentStatus[]> = {
  draft: ['prompt_ready'],
  prompt_ready: ['queued'],
  queued: ['submitted', 'failed'],
  submitted: ['polling', 'succeeded', 'failed'],
  polling: ['succeeded', 'failed'],
  succeeded: ['approved', 'rejected'],
  approved: [],
  rejected: ['queued'], // 重生成回流
  failed: ['queued'],
};
