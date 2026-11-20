/**
 * 视频 Provider 网关：抽象视频生成供应商接口。
 * P0 阶段实现 MockProvider（返回占位视频 URL），用于全链路联调。
 * 后续按需接入可灵/即梦/Vidu 等真实供应商。
 */

export interface SubmitJobInput {
  /** 分镜 ID */
  segmentId: string;
  /** 英文画面提示词 */
  prompt: string;
  /** 负面提示词 */
  negative?: string;
  /** 画幅比例 */
  aspectRatio: string;
  /** 预计时长（秒） */
  estimatedSeconds: number;
  /** 参考图路径（i2v 模式） */
  referenceImagePath?: string;
  /** 首帧参考图路径（首帧链：上一块尾帧，v1.1） */
  firstFramePath?: string;
}

export interface SubmitResult {
  providerJobId: string;
}

export interface QueryResult {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string;
  error?: string;
}

/** 供应商能力元数据：描述单个视频 Provider 的能力边界 */
export interface ProviderCapability {
  /** 单片段最长时长（秒） */
  maxDuration: number;
  /** 支持的分辨率档位 */
  supportedResolutions: string[];
  /** 是否支持首帧参考图（i2v） */
  supportsFirstFrame: boolean;
  /** 是否支持音频/对白生成 */
  supportsAudio: boolean;
  /** 接口并发上限 */
  maxConcurrency: number;
}

/** 视频生成供应商接口 */
export interface VideoProvider {
  name: string;
  /** 能力元数据 */
  capability: ProviderCapability;
  submit(job: SubmitJobInput): Promise<SubmitResult>;
  query(providerJobId: string): Promise<QueryResult>;
}

// --- MockProvider ---

const MOCK_VIDEOS = [
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
];

/**
 * MockProvider：直接返回占位视频 URL，用于无 API 额度时的全链路联调。
 * submit 后立即标记为 succeeded，query 返回固定视频 URL。
 */
export class MockProvider implements VideoProvider {
  name = 'mock';

  readonly capability: ProviderCapability = {
    maxDuration: 30,
    supportedResolutions: ['768P'],
    supportsFirstFrame: true,
    supportsAudio: false,
    maxConcurrency: 99,
  };

  /**
   * 无状态实现：不依赖进程内 Map，保证 API 进程 submit 的任务
   * 在 worker 进程 query 时同样可见（跨进程共享数据库，但 Map 不共享）。
   * 延迟判断基于 jobId 内嵌的时间戳，而非进程内存。
   */
  async submit(job: SubmitJobInput): Promise<SubmitResult> {
    const providerJobId = `mock-${job.segmentId}-${Date.now()}`;
    console.log(
      `[mock-provider] submit segmentId=${job.segmentId} providerJobId=${providerJobId}`,
    );
    return { providerJobId };
  }

  async query(providerJobId: string): Promise<QueryResult> {
    // 从 jobId 末尾解析提交时间戳，模拟 3 秒处理延迟
    const match = providerJobId.match(/-(\d+)$/);
    const createdAt = match ? Number(match[1]) : 0;
    const elapsed = Date.now() - createdAt;
    if (elapsed < 3000) {
      return { status: 'running' };
    }
    return { status: 'succeeded', videoUrl: MOCK_VIDEOS[0] };
  }
}

// --- MiniMaxProvider ---

/**
 * MiniMaxProvider：通过 MiniMax H3 API 生成视频。
 * 支持文生视频（t2v），兼容 metaso.cn 第三方 API。
 * API 文档: https://github.com/meta-sota/ComfyUI-MiniMaxH3-API
 */
export class MiniMaxProvider implements VideoProvider {
  name = 'minimax';

  readonly capability: ProviderCapability = {
    maxDuration: 30,
    supportedResolutions: ['768P', '1080P'],
    supportsFirstFrame: true,
    supportsAudio: true,
    maxConcurrency: 4,
  };

  private baseUrl: string;
  private token: string;
  private model: string;
  private resolution: string;
  private duration: number;
  private ratio: string;

  constructor(modelOverride?: string) {
    this.baseUrl = process.env.MINIMAX_BASE_URL ?? 'https://metaso.cn/api/minimax';
    this.token = process.env.MINIMAX_API_KEY ?? '';
    this.model = modelOverride ?? process.env.MINIMAX_MODEL ?? 'MiniMax-H3';
    this.resolution = process.env.MINIMAX_RESOLUTION ?? '768P';
    this.duration = Number(process.env.MINIMAX_DURATION ?? '5');
    this.ratio = process.env.MINIMAX_RATIO ?? '16:9';

    if (!this.token) {
      throw new Error('MINIMAX_API_KEY 未设置，请在 .env 中配置 MiniMax API Key');
    }
  }

  async submit(job: SubmitJobInput): Promise<SubmitResult> {
    const url = `${this.baseUrl}/v2/video_generation`;
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    // 首帧链：上一块尾帧作为首帧参考（优先于角色参考图，二者互斥使用）
    const firstFrame = job.firstFramePath ?? job.referenceImagePath;
    if (firstFrame) {
      const imageUrl = firstFrame.startsWith('http')
        ? firstFrame
        : `${process.env.PIVIDEO_WEB_URL ?? 'http://localhost:5173'}/files/${firstFrame.replace(/^storage\//, '')}`;
      content.push({ type: 'image_url', image_url: { url: imageUrl } });
    }
    content.push({ type: 'text', text: job.prompt });
    const body = {
      model: this.model,
      content,
      resolution: this.resolution,
      // MiniMax API 仅接受整数时长（小数返回 400 invalid params 2013），四舍五入到最近整数秒
      duration: Math.round(Math.min(Math.max(job.estimatedSeconds, 5), this.capability.maxDuration)),
      ratio: this.ratio,
      fast_mode: false,
    };

    console.log(`[minimax-provider] submit segmentId=${job.segmentId} model=${this.model}`);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`MiniMax submit failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json() as { task_id?: string; id?: string };
    const providerJobId = data.task_id ?? data.id ?? '';

    if (!providerJobId) {
      throw new Error('MiniMax submit failed: 未返回 task_id');
    }

    console.log(`[minimax-provider] submitted providerJobId=${providerJobId}`);
    return { providerJobId };
  }

  async query(providerJobId: string): Promise<QueryResult> {
    const url = `${this.baseUrl}/v2/query/video_generation/${providerJobId}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'failed', error: `MiniMax query failed (${resp.status}): ${errText}` };
    }

    const data = await resp.json() as {
      task?: {
        status?: string;
        content?: { url?: string };
      };
      status?: string;
      state?: string;
      video_url?: string;
      file_id?: string;
      error?: string;
      base_resp?: { status_msg?: string };
    };

    // 真实 API 结构：{ task: { status, content: { url } } }（兼容扁平结构）
    const rawStatus = (
      data.task?.status ?? data.status ?? data.state ?? ''
    ).toLowerCase();

    // MiniMax 状态映射
    let status: QueryResult['status'];
    if (rawStatus === 'succeeded' || rawStatus === 'success' || rawStatus === 'done' || rawStatus === 'completed') {
      status = 'succeeded';
    } else if (rawStatus === 'failed' || rawStatus === 'error') {
      status = 'failed';
    } else if (rawStatus === 'running' || rawStatus === 'processing' || rawStatus === 'queued') {
      status = 'running';
    } else {
      status = 'pending';
    }

    const videoUrl =
      data.task?.content?.url ?? data.video_url ?? data.file_id;
    const error = data.error ?? data.base_resp?.status_msg;

    if (status === 'failed') {
      return { status, error: error ?? 'MiniMax 生成失败' };
    }
    if (status === 'succeeded' && !videoUrl) {
      return { status: 'failed', error: 'MiniMax 返回成功但未提供视频 URL' };
    }

    return { status, videoUrl };
  }
}

// --- ImageProvider 接口 ---

export interface ImageSubmitInput {
  /** 资产卡 ID */
  assetId: string;
  /** 英文画面提示词 */
  prompt: string;
  /** 负面提示词 */
  negative?: string;
  /** 画幅比例 */
  aspectRatio: string;
}

export interface ImageResult {
  imageUrl: string;
}

export interface ImageProvider {
  name: string;
  submit(job: ImageSubmitInput): Promise<{ providerJobId: string }>;
  query(providerJobId: string): Promise<{
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    images?: ImageResult[];
    error?: string;
  }>;
}

// --- MiniMaxImageProvider ---
import { STORAGE_DIR } from '../storage';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SeedanceProvider } from './seedance';

export { SeedanceProvider } from './seedance';

/**
 * MiniMaxImageProvider：通过 MiniMax API 生成角色/场景参考图。
 * 同步调用模式：submit 时直接请求 API 并下载图片到本地。
 */
export class MiniMaxImageProvider implements ImageProvider {
  name = 'minimax-image';
  private baseUrl: string;
  private token: string;
  private model: string;
  private results = new Map<string, { status: 'pending' | 'running' | 'succeeded' | 'failed'; images?: ImageResult[]; error?: string }>();

  constructor() {
    this.baseUrl = process.env.MINIMAX_BASE_URL ?? 'https://metaso.cn/api/minimax';
    this.token = process.env.MINIMAX_API_KEY ?? '';
    this.model = process.env.MINIMAX_IMAGE_MODEL ?? 'MiniMax-H3-Image';
    if (!this.token) {
      throw new Error('MINIMAX_API_KEY 未设置，无法使用 MiniMaxImageProvider');
    }
  }

  private assetIds = new Map<string, string>();

  async submit(job: ImageSubmitInput): Promise<{ providerJobId: string }> {
    const url = `${this.baseUrl}/v2/image_generation`;
    const isPortrait = job.aspectRatio === '9:16';
    const body = {
      model: this.model,
      prompt: job.prompt,
      n: 1,
      aspect_ratio: isPortrait ? '9:16' : '16:9',
      response_format: 'url',
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`MiniMax image API error: HTTP ${resp.status} ${errText.slice(0, 300)}`);
    }

    const data = await resp.json() as { task_id?: string };
    if (!data.task_id) {
      throw new Error('MiniMax image API 未返回 task_id');
    }

    this.assetIds.set(data.task_id, job.assetId);
    console.log(`[minimax-image-provider] submit assetId=${job.assetId} taskId=${data.task_id}`);
    return { providerJobId: data.task_id };
  }

  async query(providerJobId: string): Promise<{
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    images?: ImageResult[];
    error?: string;
  }> {
    const url = `${this.baseUrl}/v2/query/image_generation/${providerJobId}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'failed', error: `query failed: HTTP ${resp.status} ${errText.slice(0, 200)}` };
    }

    const data = await resp.json() as {
      task?: {
        status: string;
        content?: { url?: string; file_id?: string };
      };
    };

    const task = data.task;
    if (!task) {
      return { status: 'running' };
    }

    if (task.status === 'succeeded' && task.content?.url) {
      const assetId = this.assetIds.get(providerJobId) ?? 'unknown';
      const imageDir = resolve(STORAGE_DIR, 'images', assetId);
      mkdirSync(imageDir, { recursive: true });

      const localPath = resolve(imageDir, 'candidate_1.jpg');
      const imgResp = await fetch(task.content.url);
      if (!imgResp.ok) {
        return { status: 'failed', error: `下载图片失败: HTTP ${imgResp.status}` };
      }
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      writeFileSync(localPath, buffer);

      console.log(`[minimax-image-provider] query succeeded, image saved for assetId=${assetId}`);
      return {
        status: 'succeeded',
        images: [{ imageUrl: `storage/images/${assetId}/candidate_1.jpg` }],
      };
    }

    if (task.status === 'failed') {
      return { status: 'failed', error: 'MiniMax image generation failed' };
    }

    return { status: 'running' };
  }
}

// --- MockImageProvider ---

const MOCK_IMAGES = [
  'https://picsum.photos/seed/pivideo-1/512/768',
  'https://picsum.photos/seed/pivideo-2/512/768',
  'https://picsum.photos/seed/pivideo-3/512/768',
  'https://picsum.photos/seed/pivideo-4/512/768',
];

export class MockImageProvider implements ImageProvider {
  name = 'mock-image';

  /**
   * 无状态实现：不依赖进程内 Map，保证 API 进程 submit 的任务
   * 在 worker 进程 query 时同样可见（跨进程共享数据库，但 Map 不共享）。
   * 延迟判断基于 jobId 内嵌的时间戳，而非进程内存。
   */

  async submit(job: ImageSubmitInput): Promise<{ providerJobId: string }> {
    const providerJobId = `mock-img-${job.assetId}-${Date.now()}`;
    console.log(
      `[mock-image-provider] submit assetId=${job.assetId} providerJobId=${providerJobId}`,
    );
    return { providerJobId };
  }

  async query(providerJobId: string): Promise<{
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    images?: ImageResult[];
    error?: string;
  }> {
    // 从 jobId 末尾解析提交时间戳，模拟 2 秒处理延迟
    const match = providerJobId.match(/-(\d+)$/);
    const createdAt = match ? Number(match[1]) : 0;
    const elapsed = Date.now() - createdAt;
    if (elapsed < 2000) {
      return { status: 'running' };
    }
    return {
      status: 'succeeded',
      images: MOCK_IMAGES.map((url) => ({ imageUrl: url })),
    };
  }
}

// --- Provider 工厂 ---

/** 返回当前配置的视频供应商名称（不实例化，供费用预估等轻量场景使用） */
export function getVideoProviderName(): string {
  return process.env.VIDEO_PROVIDER ?? 'mock';
}

let cachedProvider: VideoProvider | undefined;

/**
 * 根据环境变量 VIDEO_PROVIDER 选择供应商。
 * 默认 mock（P0 阶段全链路联调用）。
 */
export function getVideoProvider(): VideoProvider {
  if (cachedProvider) return cachedProvider;

  const providerName = process.env.VIDEO_PROVIDER ?? 'mock';

  switch (providerName) {
    case 'mock':
      cachedProvider = new MockProvider();
      break;
    case 'minimax':
      cachedProvider = new MiniMaxProvider();
      break;
    case 'seedance':
      cachedProvider = new SeedanceProvider();
      break;
    // case 'keling':
    //   cachedProvider = new KelingProvider();
    //   break;
    // case 'jimeng':
    //   cachedProvider = new JimengProvider();
    //   break;
    // case 'vidu':
    //   cachedProvider = new ViduProvider();
    //   break;
    default:
      throw new Error(
        `未知的 VIDEO_PROVIDER: ${providerName}（当前支持: mock, minimax, seedance）`,
      );
  }

  console.log(`[provider-gateway] 使用视频供应商: ${cachedProvider.name}`);
  return cachedProvider;
}

/**
 * 按名称（与可选模型覆盖）实例化 Provider（v1.1 模型路由用）。
 * 每次返回新实例以应用模型覆盖，调用方按需缓存。
 */
export function getProviderByName(name: string, model?: string): VideoProvider {
  switch (name) {
    case 'mock':
      return new MockProvider();
    case 'minimax':
      return new MiniMaxProvider(model);
    case 'seedance':
      return new SeedanceProvider(model);
    default:
      throw new Error(`未知的 provider: ${name}（当前支持: mock, minimax, seedance）`);
  }
}

// --- OpenAIImageProvider ---
// 使用 OpenAI 兼容的 /images/generations 接口（如 aimagichub.xyz）
// 同步调用：submit 时直接请求 API 并下载图片到本地，query 立即返回结果。
export class OpenAIImageProvider implements ImageProvider {
  name = 'openai-image';
  private baseUrl: string;
  private token: string;
  private model: string;
  private results = new Map<string, { status: 'pending' | 'running' | 'succeeded' | 'failed'; images?: ImageResult[]; error?: string }>();
  private assetIds = new Map<string, string>();

  constructor() {
    this.baseUrl = process.env.OPENAI_IMAGE_BASE_URL ?? 'https://aimagichub.xyz/v1';
    this.token = process.env.OPENAI_IMAGE_API_KEY ?? process.env.LLM_API_KEY ?? '';
    this.model = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2';
    if (!this.token) {
      throw new Error('OPENAI_IMAGE_API_KEY 或 LLM_API_KEY 未设置，无法使用 OpenAIImageProvider');
    }
  }

  async submit(job: ImageSubmitInput): Promise<{ providerJobId: string }> {
    const url = `${this.baseUrl}/images/generations`;
    const isPortrait = job.aspectRatio === '9:16';
    const size = isPortrait ? '768x1344' : '1344x768';
    const body = {
      model: this.model,
      prompt: job.prompt,
      n: 1,
      size,
      response_format: 'url',
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI image API error: HTTP ${resp.status} ${errText.slice(0, 300)}`);
    }
    const data = await resp.json() as { data?: Array<{ url?: string; b64_json?: string }> };
    if (!data.data || data.data.length === 0 || !data.data[0].url) {
      throw new Error('OpenAI image API 未返回图片 URL');
    }
    const imageUrl = data.data[0].url!;
    const providerJobId = `openai-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.assetIds.set(providerJobId, job.assetId);
    // 同步下载图片到本地
    const assetId = job.assetId;
    const imageDir = resolve(STORAGE_DIR, 'images', assetId);
    mkdirSync(imageDir, { recursive: true });
    const localPath = resolve(imageDir, 'candidate_1.jpg');
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) {
      this.results.set(providerJobId, { status: 'failed', error: `下载图片失败: HTTP ${imgResp.status}` });
      return { providerJobId };
    }
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    writeFileSync(localPath, buffer);
    console.log(`[openai-image-provider] submit assetId=${assetId} image saved`);
    this.results.set(providerJobId, {
      status: 'succeeded',
      images: [{ imageUrl: `storage/images/${assetId}/candidate_1.jpg` }],
    });
    return { providerJobId };
  }

  async query(providerJobId: string): Promise<{
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    images?: ImageResult[];
    error?: string;
  }> {
    const result = this.results.get(providerJobId);
    if (!result) {
      return { status: 'failed', error: '未找到图片生成结果' };
    }
    return result;
  }
}

let cachedImageProvider: ImageProvider | undefined;

/**
 * 根据环境变量 IMAGE_PROVIDER 选择图片供应商。
 * 默认 mock。
 */
export function getImageProvider(): ImageProvider {
  if (cachedImageProvider) return cachedImageProvider;

  const providerName = process.env.IMAGE_PROVIDER ?? 'mock';

  switch (providerName) {
    case 'mock':
      cachedImageProvider = new MockImageProvider();
      break;
    case 'minimax':
      cachedImageProvider = new MiniMaxImageProvider();
      break;
    case 'openai':
      cachedImageProvider = new OpenAIImageProvider();
      break;
    default:
      throw new Error(
        `未知的 IMAGE_PROVIDER: ${providerName}（当前支持: mock, minimax, openai）`,
      );
  }

  console.log(`[provider-gateway] 使用图片供应商: ${cachedImageProvider.name}`);
  return cachedImageProvider;
}

// --- 多供应商路由器 ---

/**
 * 多供应商路由器：
 * 1. 失败自动切换备用 provider
 * 2. 按片段类型（有人物/纯场景）路由不同 provider
 */
export class ProviderRouter {
  private primaryProvider: VideoProvider;
  private fallbackProvider: VideoProvider;
  private sceneProvider?: VideoProvider;

  constructor(options: {
    primary: VideoProvider;
    fallback: VideoProvider;
    scene?: VideoProvider;
  }) {
    this.primaryProvider = options.primary;
    this.fallbackProvider = options.fallback;
    this.sceneProvider = options.scene;
  }

  /**
   * 根据片段类型选择 provider
   * - 有人物（characterNames 非空）→ primary
   * - 纯场景 → sceneProvider 或 primary
   */
  selectProvider(hasCharacters: boolean): VideoProvider {
    if (!hasCharacters && this.sceneProvider) {
      return this.sceneProvider;
    }
    return this.primaryProvider;
  }

  /**
   * 提交任务，失败自动切换到 fallback provider
   */
  async submitWithFallback(
    job: SubmitJobInput,
    hasCharacters: boolean,
  ): Promise<{ providerJobId: string; providerName: string }> {
    const providers = [this.selectProvider(hasCharacters), this.fallbackProvider];
    let lastError: Error | undefined;

    for (const provider of providers) {
      try {
        const result = await provider.submit(job);
        return { providerJobId: result.providerJobId, providerName: provider.name };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[provider-router] provider ${provider.name} submit failed: ${lastError.message}, trying fallback...`,
        );
      }
    }

    throw lastError ?? new Error('所有 provider 均提交失败');
  }
}

let cachedRouter: ProviderRouter | undefined;

/**
 * 获取多供应商路由器实例。
 * P2 阶段默认 primary=mock, fallback=mock（后续可配置不同 provider）。
 */
export function getProviderRouter(): ProviderRouter {
  if (cachedRouter) return cachedRouter;

  const primary = getVideoProvider();
  const fallback = new MockProvider();

  cachedRouter = new ProviderRouter({
    primary,
    fallback,
  });

  console.log('[provider-router] 初始化多供应商路由器');
  return cachedRouter;
}
