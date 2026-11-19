// 领域模型：项目 / 分镜 / 资产 / 任务
import type { StoryProfile } from './story-analyzer';
import type { ShotClass } from './providers/router';

export type AspectRatio = '9:16' | '16:9';

export type StyleTemplate = 'narration' | 'motion-comic' | 'commentary';

export type { ShotClass, QualityTier } from './providers/router';

/** 资产层级：series=剧集级共享（300 集主角团/主场景），project=集级临时 */
export type AssetScope = 'series' | 'project';

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

/** 分场剧本中的单一场景（剧本化改写层产出，v1.1） */
export interface ScreenplayScene {
  /** 场景编号（从 1 开始） */
  sceneNo: number;
  /** 地点 */
  location: string;
  /** 时间（如：清晨/深夜/黄昏） */
  timeOfDay: string;
  /** 光源描述（方向+色温，如『左侧窗光 5600K』） */
  lighting: string;
  /** 在场角色名列表 */
  characters: string[];
  /** 情绪基调（一个词） */
  emotion: string;
  /** 可拍摄的剧本正文（动作/表情/环境反应 + 对白） */
  content: string;
  /** 对应的小说原文连续切片（用于校验不丢情节） */
  sourceText: string;
}

/** 剧本化改写结果（v1.1） */
export interface Screenplay {
  scenes: ScreenplayScene[];
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
    /** 剧本化改写产出的分场剧本（阶段 1，v1.1） */
    screenplay?: Screenplay;
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
  /** 30s 叙事块内的按秒分镜计划（v1.1） */
  shots?: ShotPlan[];
  /** 模型路由标注（v1.1） */
  shotClass?: ShotClass;
  /** 轴线锁定声明，如『甲 frame-left, 乙 frame-right』（v1.1） */
  axisLock?: string;
  /** 12 模块结构化提示词（v1.1，与旧 prompt 字段并存兼容） */
  promptV2?: PromptBundleV2;
}

/** 30s 叙事块内的单个镜头计划 */
export interface ShotPlan {
  shotNo: number;
  /** 时间码，如 '0-3s' */
  timeRange: string;
  /** 景别：空镜/近景/中近景/中景/远景/特写 */
  shotType: string;
  /** 运镜手法：固定/微推/缓摇/跟拍/升降 */
  cameraMovement: string;
  /** FOV 数值化描述，如 '47°' */
  fov?: string;
  /** 该镜头动作描述 */
  action: string;
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
  /** 资产层级：剧集级共享 / 集级临时（v1.1） */
  scope?: AssetScope;
  /** wardrobe variant：指向主角色卡 ID（v1.1） */
  variantOf?: string;
  /** 场景灯光规格：色温/方向数值化（scene 类，v1.1） */
  lightingSpec?: string;
  /** 场景声音规格（scene 类，v1.1） */
  audioSpec?: string;
  /** 角色音色绑定（character 类，Voice Registry，v1.1） */
  voiceId?: string;
}

/** 12 模块结构化提示词（Higgsfield 框架，v1.1） */
export interface PromptBundleV2 {
  modules: {
    sceneContext: string;
    activeReferences: string;
    locationMap: string;
    firstFrameBlocking: string;
    formatMode: string;
    optics: string;
    camera: string;
    actionTimeline: string;
    physics: string;
    lighting: string;
    audio: string;
    style: string;
  };
  negative: string;
  /** 组装后的最终英文提示词 */
  finalPrompt: string;
  /** 实际生成所用模型 */
  modelUsed?: string;
}

/** 剧集实体：300 集短剧的顶层容器（v1.1） */
export interface Series {
  id: string;
  title: string;
  novelProjectId?: string;
  episodeCount: number;
  /** Story Bible 全局层引用 */
  storyBible?: string;
  createdAt: string;
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
  /** 路由后的具体模型（v1.1） */
  providerModel?: string;
  /** 首帧链参考图路径（v1.1） */
  firstFramePath?: string;
  /** 自动质检结果（v1.1） */
  qcResult?: 'approved' | 'suspect' | 'rejected';
  /** 队列优先级（v1.1）：2=人工确认 regenerate / 1=失败重试 / 0=批量生成，数值越大越先出队 */
  priority?: number;
}
