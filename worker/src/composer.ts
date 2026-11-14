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
  coverPath: string;
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
 * 将单个片段统一转码为目标参数，带淡入淡出转场
 */
async function transcodeSegment(
  inputPath: string,
  outputPath: string,
  aspectRatio: string,
  fadeDuration: number,
): Promise<void> {
  const isPortrait = aspectRatio === '9:16';
  const width = isPortrait ? 1080 : 1920;
  const height = isPortrait ? 1920 : 1080;

  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fade=t=in:st=0:d=${fadeDuration}`,
    `fade=t=out:st=duration-d=${fadeDuration}:d=${fadeDuration}`,
  ].join(',');

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vf', vf,
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
 * 合并旁白音轨到视频
 */
async function mixNarrationTrack(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '44100',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    outputPath,
  ]);
}

/**
 * 混入背景音乐（ducking：旁白播放时降低背景音乐音量）
 */
async function mixBackgroundMusic(
  videoPath: string,
  bgmPath: string,
  outputPath: string,
  bgmVolume: number,
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', bgmPath,
    '-filter_complex',
    `[1:a]volume=${bgmVolume}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '44100',
    outputPath,
  ]);
}

/**
 * 烧录硬字幕
 */
async function burnSubtitles(
  videoPath: string,
  srtPath: string,
  outputPath: string,
  subtitleStyle: string,
): Promise<void> {
  const vf = `subtitles='${srtPath}':force_style='${subtitleStyle}'`;
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    outputPath,
  ]);
}

/**
 * 截取封面（第 1 秒）
 */
async function extractCover(
  videoPath: string,
  coverPath: string,
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-ss', '1',
    '-frames:v', '1',
    '-q:v', '2',
    coverPath,
  ]);
}

/**
 * 合成成片完整版：转场 + 旁白 + 背景音乐 + 字幕 + 封面。
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
  const succeeded = segments.filter((s) => s.status === 'succeeded' || s.status === 'approved');
  if (succeeded.length === 0) {
    throw new Error('没有可合成的分镜');
  }

  const job = createJob(db, {
    projectId,
    kind: 'compose',
    provider: 'ffmpeg',
  });

  transitionProjectStatus(db, projectId, 'composing');

  try {
    const outputDir = resolve('storage', 'output', projectId);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = resolve(outputDir, 'final.mp4');
    const coverPath = resolve(outputDir, 'cover.jpg');

    const fadeDuration = Number(process.env.FADE_DURATION ?? 0.5);

    // 1. 转码每个片段（带淡入淡出）
    const transcodedPaths: string[] = [];
    for (const seg of succeeded) {
      const segVideoDir = resolve('storage', 'videos', seg.id);
      const segVideoPath = resolve(segVideoDir, `v${seg.currentVersion}.mp4`);
      if (!existsSync(segVideoPath)) {
        throw new Error(`分镜视频文件不存在: ${segVideoPath}`);
      }
      const transcodedPath = resolve(segVideoDir, `v${seg.currentVersion}_tc.mp4`);
      await transcodeSegment(segVideoPath, transcodedPath, project.aspectRatio, fadeDuration);
      transcodedPaths.push(transcodedPath);
    }

    // 2. concat 拼接
    const concatPath = resolve(outputDir, 'concat_tmp.mp4');
    await concatSegments(transcodedPaths, concatPath);

    let currentPath = concatPath;

    // 3. 混入旁白音轨（如果存在）
    const audioDir = resolve('storage', 'audio', projectId);
    const narrationPath = resolve(audioDir, 'narration_full.mp3');
    if (existsSync(narrationPath)) {
      const narratedPath = resolve(outputDir, 'narrated_tmp.mp4');
      await mixNarrationTrack(currentPath, narrationPath, narratedPath);
      currentPath = narratedPath;
    }

    // 4. 混入背景音乐（如果存在）
    const bgmPath = process.env.BGM_PATH;
    if (bgmPath && existsSync(bgmPath)) {
      const bgmPath2 = resolve(outputDir, 'bgm_tmp.mp4');
      await mixBackgroundMusic(currentPath, bgmPath, bgmPath2, 0.3);
      currentPath = bgmPath2;
    }

    // 5. 烧录字幕（如果存在）
    const srtPath = resolve(audioDir, 'subtitles.srt');
    if (existsSync(srtPath)) {
      const subtitleStyle = process.env.SUBTITLE_STYLE ?? 'FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1';
      const subtitledPath = resolve(outputDir, 'subtitled_tmp.mp4');
      await burnSubtitles(currentPath, srtPath, subtitledPath, subtitleStyle);
    }

    // 6. 截取封面
    await extractCover(currentPath, coverPath);

    // 7. 最终输出
    if (currentPath !== outputPath) {
      const fs = await import('node:fs/promises');
      await fs.copyFile(currentPath, outputPath);
    }

    // ffprobe 校验时长
    const duration = await getVideoDuration(outputPath);
    const expectedDuration = succeeded.reduce((sum, s) => sum + s.estimatedSeconds, 0);
    const diff = Math.abs(duration - expectedDuration);
    if (diff > 1) {
      console.warn(
        `[composer] 时长偏差: actual=${duration}s expected=${expectedDuration}s diff=${diff}s`,
      );
    }

    updateJob(db, job.id, {
      status: 'succeeded',
      resultPath: outputPath,
    });

    transitionProjectStatus(db, projectId, 'delivering');
    transitionProjectStatus(db, projectId, 'done');

    console.log(
      `[composer] project ${projectId} composed: ${outputPath} (${duration}s), cover: ${coverPath}`,
    );
    return { outputPath, duration, coverPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(db, job.id, {
      status: 'failed',
      error: message,
    });
    try {
      transitionProjectStatus(db, projectId, 'failed');
      // 忽略状态流转错误
    } catch {
      // 忽略
    }
    throw err;
  }
}
