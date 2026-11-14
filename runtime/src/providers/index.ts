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

  private jobs = new Map<string, { videoUrl: string; createdAt: number }>();

  async submit(job: SubmitJobInput): Promise<SubmitResult> {
    const providerJobId = `mock-${job.segmentId}-${Date.now()}`;
    const videoUrl = MOCK_VIDEOS[0];
    // 模拟异步：记录任务，query 时返回成功
    this.jobs.set(providerJobId, {
      videoUrl,
      createdAt: Date.now(),
    });
    console.log(
      `[mock-provider] submit segmentId=${job.segmentId} providerJobId=${providerJobId}`,
    );
    return { providerJobId };
  }

  async query(providerJobId: string): Promise<QueryResult> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return { status: 'failed', error: `mock job not found: ${providerJobId}` };
    }
    // 模拟处理延迟：3 秒后成功
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < 3000) {
      return { status: 'running' };
    }
    return { status: 'succeeded', videoUrl: job.videoUrl };
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

  private jobs = new Map<string, { images: ImageResult[]; createdAt: number }>();

  async submit(job: ImageSubmitInput): Promise<{ providerJobId: string }> {
    const providerJobId = `mock-img-${job.assetId}-${Date.now()}`;
    this.jobs.set(providerJobId, {
      images: MOCK_IMAGES.map((url) => ({ imageUrl: url })),
      createdAt: Date.now(),
    });
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
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return { status: 'failed', error: `mock image job not found: ${providerJobId}` };
    }
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < 2000) {
      return { status: 'running' };
    }
    return { status: 'succeeded', images: job.images };
  }
}

// --- Provider 工厂 ---

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
        `未知的 VIDEO_PROVIDER: ${providerName}（当前支持: mock）`,
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
