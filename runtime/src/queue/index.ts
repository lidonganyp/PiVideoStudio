import type { DatabaseSync } from 'node:sqlite';
import { listJobsByStatus } from '../store';

interface QueueConfig {
  maxConcurrencyPerProject: number;
  maxGlobalQPS: number;
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxConcurrencyPerProject: 3,
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
  const selected: Array<{ jobId: string; projectId: string; segmentId?: string }> = [];
  const projectOrder = Array.from(byProject.keys()).sort();
  let changed = true;
  while (changed) {
    changed = false;
    for (const projectId of projectOrder) {
      const queue = byProject.get(projectId)!;
      if (queue.length === 0) continue;
      const running = runningCounts.get(projectId) ?? 0;
      const selectedForProject = selected.filter((s) => s.projectId === projectId).length;
      if (running + selectedForProject < config.maxConcurrencyPerProject) {
        const job = queue.shift()!;
        selected.push({ jobId: job.id, projectId: job.projectId, segmentId: job.segmentId });
        changed = true;
      }
    }
  }
  return selected;
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
