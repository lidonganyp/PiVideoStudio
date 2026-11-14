import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  getProject,
  listSegmentsByProject,
  createJob,
  updateJob,
} from '../store';

const execFileAsync = promisify(execFile);

export interface TTSResult {
  audioPath: string;
  duration: number;
}

/**
 * 调用 edge-tts 生成旁白音频
 */
async function generateAudio(
  text: string,
  outputPath: string,
  voice?: string,
): Promise<void> {
  const args = [
    '--text', text,
    '--write-media', outputPath,
  ];
  if (voice) {
    args.push('--voice', voice);
  }
  await execFileAsync('edge-tts', args, { timeout: 30000 });
}

/**
 * 用 ffprobe 获取音频时长（秒）
 */
async function getAudioDuration(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    audioPath,
  ]);
  const data = JSON.parse(stdout);
  return parseFloat(data.format?.duration ?? '0');
}

/**
 * 生成 SRT 字幕文件
 */
function generateSRT(
  segments: Array<{ narration: string; duration: number }>,
  outputPath: string,
): void {
  let srt = '';
  let currentTime = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startTime = currentTime;
    const endTime = currentTime + seg.duration;
    srt += `${i + 1}\n`;
    srt += `${formatSRTTime(startTime)} --> ${formatSRTTime(endTime)}\n`;
    srt += `${seg.narration}\n\n`;
    currentTime = endTime;
  }
  writeFileSync(outputPath, srt, 'utf-8');
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * 配音与字幕：为每个分镜生成旁白音频，生成整片 SRT 字幕。
 */
export async function generateTTS(
  db: DatabaseSync,
  projectId: string,
): Promise<void> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const segments = listSegmentsByProject(db, projectId);
  if (segments.length === 0) {
    throw new Error('没有分镜可生成配音');
  }

  const job = createJob(db, {
    projectId,
    kind: 'tts',
    provider: 'edge-tts',
  });

  try {
    const audioDir = resolve('storage', 'audio', projectId);
    mkdirSync(audioDir, { recursive: true });

    const ttsVoice = process.env.TTS_VOICE;
    const segmentDurations: Array<{ narration: string; duration: number }> = [];

    for (const seg of segments) {
      const narration = seg.prompt?.narration ?? seg.sourceText;
      const audioPath = resolve(audioDir, `${seg.id}_v${seg.currentVersion}.mp3`);

      if (!existsSync(audioPath)) {
        await generateAudio(narration, audioPath, ttsVoice);
      }

      const duration = await getAudioDuration(audioPath);
      segmentDurations.push({ narration, duration });

      db.prepare('UPDATE video_segments SET estimated_seconds = ? WHERE id = ?').run(duration, seg.id);
    }

    const srtPath = resolve(audioDir, 'subtitles.srt');
    generateSRT(segmentDurations, srtPath);

    updateJob(db, job.id, {
      status: 'succeeded',
    });

    console.log(
      `[tts] project ${projectId} done, ${segments.length} audio files, srt: ${srtPath}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(db, job.id, {
      status: 'failed',
      error: message,
    });
    throw err;
  }
}
