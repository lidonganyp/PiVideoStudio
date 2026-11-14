import { openDb, migrate } from '@pivideo/runtime';
import { listJobsByStatus, updateJob, getSegment, transitionSegmentStatus, getVideoProvider } from '@pivideo/runtime';
import { composeVideo } from './composer';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_INTERVAL_MS = 10_000;
const MAX_RETRY = 3;

const STORAGE_DIR = resolve(
  fileURLToPath(new URL('../../storage', import.meta.url)),
);

const db = openDb();
migrate(db);

async function downloadVideo(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`下载视频失败: HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  writeFileSync(destPath, Buffer.concat(chunks));
}

async function pollOnce(): Promise<void> {
  // 1. 处理 compose 任务
  const queuedComposeJobs = listJobsByStatus(db, 'queued').filter(
    (j) => j.kind === 'compose',
  );
  for (const job of queuedComposeJobs) {
    updateJob(db, job.id, { status: 'running' });
    try {
      const result = await composeVideo(db, job.projectId);
      console.log(
        `[worker] compose job ${job.id} done: ${result.outputPath} (${result.duration}s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] compose job ${job.id} failed: ${message}`);
    }
  }

  // 2. 处理视频生成轮询
  const provider = getVideoProvider();
  const runningJobs = listJobsByStatus(db, 'running');

  for (const job of runningJobs) {
    if (!job.providerJobId || !job.segmentId) continue;

    try {
      const result = await provider.query(job.providerJobId);

      if (result.status === 'running' || result.status === 'pending') {
        continue;
      }

      if (result.status === 'succeeded' && result.videoUrl) {
        const segment = getSegment(db, job.segmentId);
        if (!segment) continue;

        const videoDir = resolve(STORAGE_DIR, 'videos', job.segmentId);
        mkdirSync(videoDir, { recursive: true });
        const videoPath = resolve(videoDir, `v${segment.currentVersion}.mp4`);

        await downloadVideo(result.videoUrl, videoPath);

        updateJob(db, job.id, {
          status: 'succeeded',
          resultPath: videoPath,
        });
        transitionSegmentStatus(db, job.segmentId, 'succeeded');
        console.log(
          `[worker] segment ${job.segmentId} succeeded, video: ${videoPath}`,
        );
      } else if (result.status === 'failed') {
        const retryCount = job.retryCount + 1;
        if (retryCount < MAX_RETRY) {
          const submitResult = await provider.submit({
            segmentId: job.segmentId,
            prompt: '',
            aspectRatio: '9:16',
            estimatedSeconds: 5,
          });
          updateJob(db, job.id, {
            providerJobId: submitResult.providerJobId,
            retryCount,
            status: 'running',
            error: result.error,
          });
          console.log(
            `[worker] segment ${job.segmentId} retry ${retryCount}/${MAX_RETRY}`,
          );
        } else {
          updateJob(db, job.id, {
            status: 'failed',
            retryCount,
            error: result.error ?? 'max retries exceeded',
          });
          transitionSegmentStatus(db, job.segmentId, 'failed');
          console.log(
            `[worker] segment ${job.segmentId} failed after ${retryCount} retries`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] job ${job.id} error: ${message}`);
      updateJob(db, job.id, { error: message });
    }
  }
}

async function main(): Promise<void> {
  console.log('[pivideo-worker] started, polling interval:', POLL_INTERVAL_MS + 'ms');
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[pivideo-worker] poll error:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[pivideo-worker] fatal:', err);
  process.exit(1);
});
