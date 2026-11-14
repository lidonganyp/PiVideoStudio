import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  getProject,
  listSegmentsByProject,
  transitionProjectStatus,
  createJob,
  updateJob,
} from '@pivideo/runtime';

const execFileAsync = promisify(execFile);

interface ComposeResult {
  outputPath: string;
  duration: number;
}

/**
 * 获取视频时长（秒）
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    videoPath,
  ]);
  const data = JSON.parse(stdout);
  return parseFloat(data.format?.duration ?? '0');
}

/**
 * 将单个片段统一转码为目标参数
 */
async function transcodeSegment(
  inputPath: string,
  outputPath: string,
  aspectRatio: string,
): Promise<void> {
  const isPortrait = aspectRatio === '9:16';
  const width = isPortrait ? 1080 : 1920;
  const height = isPortrait ? 1920 : 1080;

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    '-r', '30',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '44100',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

/**
 * ffmpeg concat demuxer 拼接
 */
async function concatSegments(
  segmentPaths: string[],
  outputPath: string,
): Promise<void> {
  const listFile = outputPath + '.concat.txt';
  const lines = segmentPaths.map((p) => `file '${p}'`);
  writeFileSync(listFile, lines.join('\n') + '\n');

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outputPath,
    ]);
  } finally {
    if (existsSync(listFile)) unlinkSync(listFile);
  }
}

/**
 * 合成成片：拼接所有 succeeded 分镜。
 * 项目状态：segment_generating → composing → delivering → done
 */
export async function composeVideo(
  db: DatabaseSync,
  projectId: string,
): Promise<ComposeResult> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const segments = listSegmentsByProject(db, projectId);
  const succeeded = segments.filter((s) => s.status === 'succeeded');
  if (succeeded.length === 0) {
    throw new Error('没有 succeeded 状态的分镜可合成');
  }

  // 创建 compose 任务
  const job = createJob(db, {
    projectId,
    kind: 'compose',
    provider: 'ffmpeg',
  });

  // 项目状态 → composing
  transitionProjectStatus(db, projectId, 'composing');

  try {
    const outputDir = resolve('storage', 'output', projectId);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = resolve(outputDir, 'final.mp4');

    // 转码每个片段到统一参数
    const transcodedPaths: string[] = []
    for (const seg of succeeded) {
      // 查找分镜视频文件
      const segVideoDir = resolve('storage', 'videos', seg.id);
      const segVideoPath = resolve(segVideoDir, `v${seg.currentVersion}.mp4`);
      if (!existsSync(segVideoPath)) {
        throw new Error(`分镜视频文件不存在: ${segVideoPath}`);
      }
      const transcodedPath = resolve(segVideoDir, `v${seg.currentVersion}_tc.mp4`);
      await transcodeSegment(segVideoPath, transcodedPath, project.aspectRatio);
      transcodedPaths.push(transcodedPath);
    }

    // concat 拼接
    await concatSegments(transcodedPaths, outputPath);

    // ffprobe 校验时长
    const duration = await getVideoDuration(outputPath);
    const expectedDuration = succeeded.reduce((sum, s) => sum + s.estimatedSeconds, 0);
    const diff = Math.abs(duration - expectedDuration);
    if (diff > 1) {
      console.warn(
        `[composer] 时长偏差: actual=${duration}s expected≈${expectedDuration}s diff=${diff}s`,
      );
    }

    // 更新任务
    updateJob(db, job.id, {
      status: 'succeeded',
      resultPath: outputPath,
    });

    // 项目状态 → delivering → done
    transitionProjectStatus(db, projectId, 'delivering');
    transitionProjectStatus(db, projectId, 'done');

    console.log(
      `[composer] project ${projectId} composed: ${outputPath} (${duration}s)`,
    );

    return { outputPath, duration };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(db, job.id, {
      status: 'failed',
      error: message,
    });
    try {
      transitionProjectStatus(db, projectId, 'failed');
    } catch {
      // 忽略状态流转错误
    }
    throw err;
  }
}
