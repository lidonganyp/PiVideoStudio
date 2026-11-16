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
}

export interface SubmitResult {
  providerJobId: string;
}

export interface QueryResult {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string;
  error?: string;
}

/** 视频生成供应商接口 */
export interface VideoProvider {
  name: string;
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

  private baseUrl: string;
  private token: string;
  private model: string;
  private resolution: string;
  private duration: number;
  private ratio: string;

  constructor() {
    this.baseUrl = process.env.MINIMAX_BASE_URL ?? 'https://metaso.cn/api/minimax';
    this.token = process.env.MINIMAX_API_KEY ?? '';
    this.model = process.env.MINIMAX_MODEL ?? 'MiniMax-H3';
    this.resolution = process.env.MINIMAX_RESOLUTION ?? '768P';
    this.duration = Number(process.env.MINIMAX_DURATION ?? '5');
    this.ratio = process.env.MINIMAX_RATIO ?? '16:9';

    if (!this.token) {
      throw new Error('MINIMAX_API_KEY 未设置，请在 .env 中配置 MiniMax API Key');
    }
  }

  async submit(job: SubmitJobInput): Promise<SubmitResult> {
    const url = `${this.baseUrl}/v2/video_generation`;
    const body = {
      model: this.model,
      content: [{ type: 'text', text: job.prompt }],
      resolution: this.resolution,
      duration: Math.min(Math.max(job.estimatedSeconds, 5), 15),
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
        `未知的 VIDEO_PROVIDER: ${providerName}（当前支持: mock, minimax）`,
      );
  }

  console.log(`[provider-gateway] 使用视频供应商: ${cachedProvider.name}`);
  return cachedProvider;
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
    default:
      throw new Error(
        `未知的 IMAGE_PROVIDER: ${providerName}（当前支持: mock）`,
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
