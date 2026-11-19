import type {
  ProviderCapability,
  QueryResult,
  SubmitJobInput,
  SubmitResult,
  VideoProvider,
} from './index';

/**
 * SeedanceProvider：火山引擎方舟 Seedance 全系视频生成（P3，v1.1）。
 *
 * 模型矩阵（QUALITY_TIER=prod 稳定期）：
 * - seedance-2.5：对话/表演/VFX（30s，高能力）
 * - seedance-2.0-mini：空镜 broll
 * - seedance-2.0-fast：草稿迭代 draft
 *
 * API 结构参照方舟内容生成任务接口：
 * - submit: POST {base}/api/v3/contents/generations/tasks
 * - query:  GET  {base}/api/v3/contents/generations/tasks/{id}
 * 具体字段以实际 API 文档为准，联调时按需校准。
 *
 * 环境变量：
 * - SEEDANCE_BASE_URL（默认 https://ark.cn-beijing.volces.com）
 * - SEEDANCE_API_KEY
 * - SEEDANCE_MODEL（默认 seedance-2.5；由 router 按镜头类型分流时经 SEEDANCE_MODEL 覆盖）
 * - SEEDANCE_RESOLUTION（默认 720p，2.5 可升 1080p）
 * - SEEDANCE_RATIO（默认 16:9）
 */
export class SeedanceProvider implements VideoProvider {
  name = 'seedance';

  readonly capability: ProviderCapability = {
    maxDuration: 30,
    supportedResolutions: ['720p', '1080p'],
    supportsFirstFrame: true,
    supportsAudio: true,
    maxConcurrency: 4,
  };

  private baseUrl: string;
  private token: string;
  private model: string;
  private resolution: string;
  private ratio: string;

  constructor(modelOverride?: string) {
    this.baseUrl = process.env.SEEDANCE_BASE_URL ?? 'https://ark.cn-beijing.volces.com';
    this.token = process.env.SEEDANCE_API_KEY ?? '';
    this.model = modelOverride ?? process.env.SEEDANCE_MODEL ?? 'seedance-2.5';
    this.resolution = process.env.SEEDANCE_RESOLUTION ?? '720p';
    this.ratio = process.env.SEEDANCE_RATIO ?? '16:9';
    if (!this.token) {
      throw new Error('SEEDANCE_API_KEY 未设置，请在 .env 中配置 Seedance API Key');
    }
  }

  async submit(job: SubmitJobInput): Promise<SubmitResult> {
    const url = `${this.baseUrl}/api/v3/contents/generations/tasks`;
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    // 首帧参考（首帧链）优先于角色参考图
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
      duration: Math.min(Math.max(job.estimatedSeconds, 5), this.capability.maxDuration),
      ratio: this.ratio,
      resolution: this.resolution,
    };
    console.log(`[seedance-provider] submit segmentId=${job.segmentId} model=${this.model}`);
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
      throw new Error(`Seedance submit failed (${resp.status}): ${errText}`);
    }
    const data = await resp.json() as { id?: string; task_id?: string };
    const providerJobId = data.id ?? data.task_id ?? '';
    if (!providerJobId) {
      throw new Error('Seedance submit failed: 未返回任务 ID');
    }
    console.log(`[seedance-provider] submitted providerJobId=${providerJobId}`);
    return { providerJobId };
  }

  async query(providerJobId: string): Promise<QueryResult> {
    const url = `${this.baseUrl}/api/v3/contents/generations/tasks/${providerJobId}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'failed', error: `Seedance query failed (${resp.status}): ${errText}` };
    }
    const data = await resp.json() as {
      status?: string;
      state?: string;
      content?: { video_url?: string };
      video_url?: string;
      error?: { message?: string } | string;
    };
    const rawStatus = (data.status ?? data.state ?? '').toLowerCase();
    let status: QueryResult['status'];
    if (rawStatus === 'succeeded' || rawStatus === 'success' || rawStatus === 'done') {
      status = 'succeeded';
    } else if (rawStatus === 'failed' || rawStatus === 'error') {
      status = 'failed';
    } else if (rawStatus === 'running' || rawStatus === 'processing' || rawStatus === 'queued') {
      status = 'running';
    } else {
      status = 'pending';
    }
    const videoUrl = data.content?.video_url ?? data.video_url;
    const error =
      typeof data.error === 'string' ? data.error : data.error?.message;
    if (status === 'failed') {
      return { status, error: error ?? 'Seedance 生成失败' };
    }
    if (status === 'succeeded' && !videoUrl) {
      return { status: 'failed', error: 'Seedance 返回成功但未提供视频 URL' };
    }
    return { status, videoUrl };
  }
}
