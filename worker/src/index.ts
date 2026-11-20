import './env';
import { openDb, migrate } from '@pivideo/runtime';
import { listJobsByStatus, listJobsByHoldId, updateJob, getSegment, transitionSegmentStatus, getVideoProvider, extractLastFrame, isFirstFrameChainEnabled, runQC, isAutoQCEnabled, persistQCResult, billingConfigFromEnv, settleCall as billingSettleCall, finalizeHold as billingFinalizeHold, secondsToTokens, BILLING_MODEL_VIDEO } from '@pivideo/runtime';
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

// B7 融合：计费客户端（PINOVEL_API_URL + INTERNAL_API_SECRET 配置后启用）
const billingCfg = billingConfigFromEnv();

/** job 成功结算：按 estimatedSeconds 计费（jobId+callId 幂等，重试不重复扣费）。 */
async function settleJobSuccess(job: { id: string; billingHoldId?: string }, seconds: number): Promise<void> {
  if (!billingCfg || !job.billingHoldId) return;
  try {
    await billingSettleCall(billingCfg, {
      jobId: job.billingHoldId,
      callId: job.id,
      internalStage: 'video_generation',
      model: BILLING_MODEL_VIDEO,
      tokensIn: secondsToTokens(seconds),
      tokensOut: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing] settle job ${job.id} failed: ${message}`);
  }
}

/** job 终态后检查计费批次：全部终态则 finalize（有成功→success，全失败→failure）。 */
async function maybeFinalizeHold(job: { id: string; billingHoldId?: string }): Promise<void> {
  if (!billingCfg || !job.billingHoldId) return;
  try {
    const batchJobs = listJobsByHoldId(db, job.billingHoldId);
    if (batchJobs.length === 0) return;
    const allTerminal = batchJobs.every((j) => j.status === 'succeeded' || j.status === 'failed');
    if (!allTerminal) return;
    const anySuccess = batchJobs.some((j) => j.status === 'succeeded');
    await billingFinalizeHold(billingCfg, job.billingHoldId, anySuccess ? 'success' : 'failure');
    console.log(`[billing] hold ${job.billingHoldId} finalized (${anySuccess ? 'success' : 'failure'}), jobs=${batchJobs.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing] finalize hold ${job.billingHoldId} failed: ${message}`);
  }
}

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
      updateJob(db, job.id, {
        status: 'succeeded',
        resultPath: result.outputPath,
      });
      console.log(
        `[worker] compose job ${job.id} done: ${result.outputPath} (${result.duration}s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateJob(db, job.id, { status: 'failed', error: message });
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
        // B7 融合：成功结算 + 批次收尾检查
        await settleJobSuccess(job, segment.estimatedSeconds);
        await maybeFinalizeHold(job);
        // 首帧链：抽取尾帧供下一块作首帧参考（失败仅告警，不阻断主流程）
        if (isFirstFrameChainEnabled()) {
          try {
            await extractLastFrame(videoPath, job.segmentId);
            console.log(`[worker] first-frame chain: extracted lastframe for segment ${job.segmentId}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[worker] first-frame chain: extract lastframe failed for segment ${job.segmentId}: ${message}`);
          }
        }
        // 自动 QC 三级分流：approved/suspect/rejected，结果写入 job.qcResult
        // 初期宽松策略：rejected 仅标注+告警，不自动回流重生成（人工决定）
        if (isAutoQCEnabled()) {
          try {
            const report = await runQC(segment, videoPath);
            persistQCResult(db, job.segmentId, report);
            if (report.verdict === 'rejected') {
              console.error(`[worker] qc: segment ${job.segmentId} REJECTED: ${report.issues.map((i) => i.message).join('; ')}`);
            } else {
              console.log(`[worker] qc: segment ${job.segmentId} verdict=${report.verdict} issues=${report.issues.length} humanReview=${report.needsHumanReview}`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[worker] qc failed for segment ${job.segmentId}: ${message}`);
          }
        }
        console.log(
          `[worker] segment ${job.segmentId} succeeded, video: ${videoPath}`,
        );
      } else if (result.status === 'failed') {
        const retryCount = job.retryCount + 1;
        if (retryCount < MAX_RETRY) {
          const segment = getSegment(db, job.segmentId);
          const prompt = segment?.prompt?.visual ?? '';
          const qualitySuffix = segment?.prompt?.globalQualitySuffix ?? '';
          const fullPrompt = qualitySuffix ? `${prompt} ${qualitySuffix}` : prompt;
          if (!fullPrompt) {
            updateJob(db, job.id, {
              status: 'failed',
              retryCount,
              error: 'retry failed: segment prompt is empty',
            });
            transitionSegmentStatus(db, job.segmentId, 'failed');
            continue;
          }
          const submitResult = await provider.submit({
            segmentId: job.segmentId,
            prompt: fullPrompt,
            aspectRatio: '9:16',
            estimatedSeconds: segment?.estimatedSeconds ?? 5,
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
          // B7 融合：终态后检查批次收尾
          await maybeFinalizeHold(job);
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
