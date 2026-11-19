import type { DatabaseSync } from 'node:sqlite';
import {
  listJobsByStatus,
  updateJob,
  getSegment,
  transitionSegmentStatus,
} from '../store';

interface QueueConfig {
  maxConcurrencyPerProject: number;
  /** Provider 维度全局并发上限（对齐视频接口并发上限，如 MiniMax-H3 为 4） */
  maxProviderConcurrency: number;
  maxGlobalQPS: number;
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxConcurrencyPerProject: 4,
  maxProviderConcurrency: Number(process.env.PROVIDER_MAX_CONCURRENCY ?? '4'),
  maxGlobalQPS: 5,
  pollIntervalMs: 10000,
};

let callCountInWindow = 0;
let windowStartTime = Date.now();

async function rateLimit(config: QueueConfig): Promise<void> {
  const now = Date.now();
  const elapsed = now - windowStartTime;
  if (elapsed >= 1000) {
    windowStartTime = now;
    callCountInWindow = 0;
  }
  if (callCountInWindow >= config.maxGlobalQPS) {
    const waitMs = 1000 - elapsed;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    windowStartTime = Date.now();
    callCountInWindow = 0;
  }
  callCountInWindow++;
}

function getProjectRunningCounts(db: DatabaseSync): Map<string, number> {
  const runningJobs = listJobsByStatus(db, 'running');
  const counts = new Map<string, number>();
  for (const job of runningJobs) {
    const current = counts.get(job.projectId) ?? 0;
    counts.set(job.projectId, current + 1);
  }
  return counts;
}

/**
 * 优先级出队（v1.1）：
 * - 队列内按 priority 降序（2=人工确认 regenerate > 1=失败重试 > 0=批量生成），
 *   同优先级按创建时间升序（FIFO）；
 * - 项目间保持公平轮询（每轮每项目最多取一个），Provider 全局并发闸门不变。
 */
export function selectNextBatch(
  db: DatabaseSync,
  config: QueueConfig = DEFAULT_CONFIG,
): Array<{ jobId: string; projectId: string; segmentId?: string }> {
  const queuedJobs = listJobsByStatus(db, 'queued');
  const runningCounts = getProjectRunningCounts(db);
  const byProject = new Map<string, typeof queuedJobs>();
  for (const job of queuedJobs) {
    const arr = byProject.get(job.projectId) ?? [];
    arr.push(job);
    byProject.set(job.projectId, arr);
  }
  // 队列内优先级排序：priority 降序，同优先级 FIFO
  for (const queue of byProject.values()) {
    queue.sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt),
    );
  }
  const selected: Array<{ jobId: string; projectId: string; segmentId?: string }> = [];
  const projectOrder = Array.from(byProject.keys()).sort();
  // Provider 全局并发闸门：全部项目的 running + 本轮已选任务不得超过接口并发上限
  const totalRunning = Array.from(runningCounts.values()).reduce((sum, n) => sum + n, 0);
  let providerUsed = totalRunning;
  let changed = true;
  while (changed) {
    changed = false;
    for (const projectId of projectOrder) {
      const queue = byProject.get(projectId)!;
      if (queue.length === 0) continue;
      if (providerUsed >= config.maxProviderConcurrency) break;
      const running = runningCounts.get(projectId) ?? 0;
      const selectedForProject = selected.filter((s) => s.projectId === projectId).length;
      if (running + selectedForProject < config.maxConcurrencyPerProject) {
        const job = queue.shift()!;
        selected.push({ jobId: job.id, projectId: job.projectId, segmentId: job.segmentId });
        providerUsed++;
        changed = true;
      }
    }
  }
  return selected;
}

/**
 * 断点续跑（v1.1）：进程重启后，DB 中遗留的 running 任务已无进程轮询，
 * 统一回退为 queued 等待重新调度（retryCount+1 留痕）；
 * 对应 segment 从 submitted/polling 回退到 queued（经 failed 中转，合法转换链）。
 * 应在服务启动时调用一次。
 */
export function recoverStaleJobs(db: DatabaseSync): { recovered: number } {
  const runningJobs = listJobsByStatus(db, 'running');
  let recovered = 0;
  for (const job of runningJobs) {
    updateJob(db, job.id, {
      status: 'queued',
      retryCount: job.retryCount + 1,
    });
    if (job.segmentId) {
      const seg = getSegment(db, job.segmentId);
      if (seg && (seg.status === 'submitted' || seg.status === 'polling')) {
        transitionSegmentStatus(db, seg.id, 'failed');
        transitionSegmentStatus(db, seg.id, 'queued');
      }
    }
    recovered++;
  }
  if (recovered > 0) {
    console.log(`[queue] 断点续跑：恢复 ${recovered} 个遗留 running 任务为 queued`);
  }
  return { recovered };
}

/** 判断是否为可重试错误：限流（429/too many requests）与瞬态网络/服务端错误 */
export function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|too many requests|50[234]|timeout|etimedout|econnreset|econnrefused/i.test(
    msg,
  );
}

export interface BackoffOptions {
  /** 最大重试次数（不含首次调用），默认 3 */
  maxRetries?: number;
  /** 首次退避基数（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 单次退避上限（毫秒），默认 30000 */
  maxDelayMs?: number;
  /** 自定义可重试判断，默认 isRetryableError */
  retryOn?: (err: unknown) => boolean;
}

/**
 * 限流指数退避（v1.1）：对可重试错误按 baseDelay * 2^attempt 指数退避重试，
 * 退避上限 maxDelayMs。用于 Provider 提交/查询调用的包装。
 */
export async function callWithBackoff<T>(
  fn: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const retryOn = options.retryOn ?? isRetryableError;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !retryOn(err)) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      console.warn(
        `[queue] 第 ${attempt + 1} 次重试（指数退避 ${delay}ms）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

export async function rateLimitedCall<T>(
  fn: () => Promise<T>,
  config: QueueConfig = DEFAULT_CONFIG,
): Promise<T> {
  await rateLimit(config);
  return fn();
}

export { DEFAULT_CONFIG };
export type { QueueConfig };
