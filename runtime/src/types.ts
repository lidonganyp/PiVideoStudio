// 领域模型：项目 / 分镜 / 资产 / 任务
import type { StoryProfile } from './story-analyzer';

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

/** PiNovelStudio 推送的人物卡（原作设定，N1/N4 优先采用） */
export interface NovelContextCharacter {
  name: string;
  roleType?: string;
  identity?: string;
  personality?: string;
  relationships?: string;
  notes?: string;
}

/** PiNovelStudio 推送的大纲节点 */
export interface NovelContextOutlineNode {
  title: string;
  summary?: string;
  nodeType?: string;
}

/** PiNovelStudio 推送的结构化上下文（章节发起视频生成时携带） */
export interface NovelContext {
  source: 'pinovelstudio';
  novelProjectId?: number;
  novelProjectTitle?: string;
  outline?: NovelContextOutlineNode[];
  characters?: NovelContextCharacter[];
  seed?: {
    intent?: string;
    mustInclude?: string;
    endingGoal?: string;
  };
}

export interface VideoProject {
  id: string;
  title: string;
  novelSource: {
    projectId?: string;
    chapterIds: string[];
    rawText?: string;
    /** N1 文本解析产出的全片级故事档案 */
    storyProfile?: StoryProfile;
    /** PiNovelStudio 推送的结构化上下文（B6） */
    novelContext?: NovelContext;
  };
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
  /** 事件：该切片发生的核心动作（一句话） */
  event: string;
  /** 人物状态：主要人物在本切片的状态（情绪/动作/位置） */
  characterState: string;
  /** 下一场景钩子：与下一个切片的衔接点（场景/视线/动作延续） */
  nextSceneHint: string;
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

  /** 场景级上下文（同场景共享） */
  sceneContext?: {
    location: string;
    timeOfDay: string;
    lighting: string;
    ambientSound: string;
  };

  /** 衔接说明：与上一分镜的连续性描述 */
  continuity?: string;

  /** 分镜级精细化字段 */
  shotType?: string;       // 景别：近景/中景/空镜
  composition?: string;    // 构图：画面元素布局
  cameraMovement?: string;   // 运镜手法：固定+微推/缓摇
  gazeDirection?: string;   // 朝向：墨→凤
  lipSync?: 'speak' | 'inner' | 'none';  // 口型模式
  soundDesign?: string;      // 音效设计（分层描述）

  /** 全局质量后缀（按风格模板选择） */
  globalQualitySuffix?: string;
}

export type AssetKind = 'character' | 'scene';

export interface AssetCard {
  id: string;
  projectId: string;
  kind: AssetKind;
  name: string;
  description: string;
  referenceImagePath?: string;
  /** 候选参考图列表（4 选 1 确认前暂存） */
  candidateImages: string[];
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
