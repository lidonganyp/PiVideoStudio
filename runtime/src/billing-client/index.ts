/**
 * PiNovelStudio 计费内部 API 客户端（B7 融合：统一余额）。
 *
 * 通过 HMAC-SHA256 签名调用 platform 的 /internal/billing/* 接口，
 * 复用其预占（hold）/ 逐笔结算（settle）/ 收尾（finalize）体系：
 *   - hold：任务开始前冻结预估金额，余额不足拒绝
 *   - settle：每笔调用按量结算（jobId+callId 幂等），超出预占封顶
 *   - finalize：任务收尾，success→settled / failure→released（未结算部分释放）
 *
 * 签名算法与 platform hmac.ts 对齐：
 *   canonical = `${timestamp}\n${nonce}\n${METHOD}\n${path}\n${sha256(stableBody)}`
 *   stableBody = 对象键按字典序稳定序列化
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface BillingClientConfig {
  /** PiNovelStudio API 地址（如 http://172.17.0.1:3000） */
  baseUrl: string;
  /** INTERNAL_API_SECRET（与 PiNovelStudio 共享） */
  secret: string;
}

export interface HoldView {
  jobId: string;
  userId: number;
  /** 金额（分，字符串形式） */
  amount: string;
  settledAmount: string;
  status: string;
  alreadyExisted: boolean;
  alreadyFinalized: boolean;
}

export interface SettleResult {
  jobId: string;
  callId: string;
  alreadySettled: boolean;
  actualCharge: string;
  settledAmount: string;
  remainingBudget: string;
}

/** 对象键按字典序稳定序列化（与 platform hmac.ts stableStringify 对齐）。 */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function internalFetch<T>(
  cfg: BillingClientConfig,
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
): Promise<T> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  // base64url(16 字节) = 22 字符，符合 nonce 格式 [A-Za-z0-9._~-]{16,128}
  const nonce = randomBytes(16).toString('base64url');
  const stableBody = body === undefined ? '' : stableStringify(body);
  const bodyHash = createHash('sha256').update(stableBody, 'utf8').digest('hex');
  const canonical = `${timestamp}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
  const signature = createHmac('sha256', cfg.secret)
    .update(canonical, 'utf8')
    .digest('hex');

  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Timestamp': timestamp,
      'X-Internal-Nonce': nonce,
      'X-Internal-Signature': signature,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `billing API ${method} ${path} failed: HTTP ${resp.status} ${text.slice(0, 200)}`,
    );
  }
  return (await resp.json()) as T;
}

/** 创建预占（幂等：同 jobId 同金额重复调用返回 alreadyExisted）。 */
export function createHold(
  cfg: BillingClientConfig,
  input: { userId: number; jobId: string; amountFen: number },
): Promise<HoldView> {
  return internalFetch(cfg, 'POST', '/internal/billing/holds', {
    userId: input.userId,
    jobId: input.jobId,
    amount: input.amountFen,
  });
}

/**
 * 逐笔结算（jobId+callId 幂等）。
 * 计费公式：tokensIn × inputPrice/1e6 + tokensOut × outputPrice/1e6（分）。
 * 视频按秒计费映射：tokensIn = 秒数 × 1_000_000，inputPrice = 每秒分价。
 */
export function settleCall(
  cfg: BillingClientConfig,
  input: {
    jobId: string;
    callId: string;
    internalStage: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
  },
): Promise<SettleResult> {
  return internalFetch(cfg, 'POST', '/internal/billing/settlements', input);
}

/** 收尾预占：success→settled / failure→released（未结算部分解冻）。 */
export function finalizeHold(
  cfg: BillingClientConfig,
  jobId: string,
  outcome: 'success' | 'failure',
): Promise<HoldView> {
  // jobId 仅含 UUID 安全字符，无需编码；签名 path 与实际请求 path 一致
  return internalFetch(
    cfg,
    'POST',
    `/internal/billing/holds/${jobId}/finalize`,
    { outcome },
  );
}

/** 从环境变量构建客户端配置；未配置完整时返回 null（计费关闭）。 */
export function billingConfigFromEnv(): BillingClientConfig | null {
  const baseUrl = process.env.PINOVEL_API_URL;
  const secret = process.env.INTERNAL_API_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

// ---- 计费常量与换算 ----

/** 视频生成：MiniMax-H3，0.09 元/秒 = 9 分/秒 */
export const VIDEO_FEN_PER_SECOND = 9;
/** 参考图生成：MiniMax-H3-Image，0.05 元/次 = 5 分/次 */
export const IMAGE_FEN_PER_CALL = 5;
/** TTS 生成：粗估 0.02 元/次 = 2 分/次 */
export const TTS_FEN_PER_CALL = 2;

/** model_rates 表中的计费模型 key（需在 PiNovelStudio 侧插入对应费率行） */
export const BILLING_MODEL_VIDEO = 'pivideo_minimax_h3';
export const BILLING_MODEL_IMAGE = 'pivideo_minimax_h3_image';
export const BILLING_MODEL_TTS = 'pivideo_minimax_tts';

/** 秒数 → tokensIn 换算（inputPrice=9 分/百万 token 时，tokensIn=秒×1e6 → 9 分/秒） */
export function secondsToTokens(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

/** 次数 → tokensIn 换算（inputPrice=5 分/百万 token 时，tokensIn=1e6 → 5 分/次） */
export function callsToTokens(calls: number): number {
  return calls * 1_000_000;
}

/** 批次预占金额估算（分）：视频秒数 + 图片 + TTS，上浮 20% 余量。 */
export function estimateHoldFen(input: {
  totalSeconds: number;
  imageCalls: number;
  ttsCalls: number;
}): number {
  const raw =
    input.totalSeconds * VIDEO_FEN_PER_SECOND +
    input.imageCalls * IMAGE_FEN_PER_CALL +
    input.ttsCalls * TTS_FEN_PER_CALL;
  return Math.ceil(raw * 1.2);
}
