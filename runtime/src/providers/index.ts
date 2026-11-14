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
