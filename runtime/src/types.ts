// 领域模型：项目 / 分镜 / 资产 / 任务

export type AspectRatio = '9:16' | '16:9';

export type StyleTemplate = 'narration' | 'motion-comic' | 'commentary';

/** 项目状态：对应九阶段流水线 */
export type ProjectStatus =
  | 'planning' // 0 任务创建
  | 'splitting' // 1 文本拆分
  | 'asset_extracting' // 2 角色场景资产提取
  | 'prompt_building' // 3 分镜提示词生成
  | 'reference_generating' // 4 参考图生成
  | 'segment_generating' // 5 视频片段生成
  | 'reviewing' // 6 片段审核
  | 'composing' // 7 配音字幕 + 8 ffmpeg 合成
  | 'delivering' // 9 交付
  | 'done'
  | 'failed';

/** 分镜状态 */
export type SegmentStatus =
  | 'draft'
  | 'prompt_ready'
  | 'queued'
  | 'submitted'
  | 'polling'
  | 'succeeded'
  | 'failed'
  | 'approved'
  | 'rejected';

export interface VideoProject {
  id: string;
  title: string;
  novelSource: { projectId?: string; chapterIds: string[]; rawText?: string };
  style: StyleTemplate;
  aspectRatio: AspectRatio;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Segment {
  id: string;
  projectId: string;
  order: number;
  sourceText: string;
  sceneSummary: string;
  characterNames: string[];
  emotion: string;
  estimatedSeconds: number;
  status: SegmentStatus;
  currentVersion: number;
  prompt?: PromptBundle;
}

export interface PromptBundle {
  camera: string;
  visual: string;
  negative?: string;
  narration: string;
  subtitle: string;
}

export type AssetKind = 'character' | 'scene';

export interface AssetCard {
  id: string;
  projectId: string;
  kind: AssetKind;
  name: string;
  description: string;
  referenceImagePath?: string;
}

export type JobKind = 't2i' | 'i2v' | 't2v' | 'tts' | 'compose';

export interface VideoJob {
  id: string;
  projectId: string;
  segmentId?: string;
  kind: JobKind;
  provider: string;
  providerJobId?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  retryCount: number;
  resultPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
