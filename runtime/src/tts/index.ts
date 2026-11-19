/**
 * TTS 配音 + 字幕生成模块
 * 使用 node-edge-tts（Node.js 原生，无需 Python）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EdgeTTS } from 'node-edge-tts';
import {
  getProject,
  listSegmentsByProject,
  listAssetsByProject,
  createJob,
  updateJob,
} from '../store';
import { STORAGE_DIR } from '../storage';

const execFileAsync = promisify(execFile);

export interface TTSResult {
  audioPath: string;
  duration: number;
}

/**
 * 使用 node-edge-tts 生成旁白音频
 */
async function generateAudio(
  text: string,
  outputPath: string,
  voice?: string,
): Promise<void> {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const tts = new EdgeTTS({
        voice: voice ?? 'zh-CN-YunyangNeural',
        lang: 'zh-CN',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        rate: '-10%',
        timeout: 30000,
      });
      await tts.ttsPromise(text, outputPath);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') && attempt < maxRetries - 1) {
        const delay = (attempt + 1) * 5000;
        console.warn(`[tts] 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
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
 * 用 ffmpeg 合并多个音频文件为一个连续音频
 */
async function concatAudioFiles(
  audioPaths: string[],
  outputPath: string,
): Promise<void> {
  const listFile = outputPath + '.concat.txt';
  const lines = audioPaths.map((p) => `file '${p}'`);
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
    if (existsSync(listFile)) {
      unlinkSync(listFile);
    }
  }
}

/**
 * 音频策略（v1.1）：
 * - hybrid：主角按角色资产卡 voiceId 绑定固定音色（跨集锁定），
 *   配角/旁白用默认音色
 * - uniform：全部使用统一默认音色（旧行为）
 */
export type AudioStrategy = 'hybrid' | 'uniform';

export function getAudioStrategy(): AudioStrategy {
  return process.env.AUDIO_STRATEGY === 'uniform' ? 'uniform' : 'hybrid';
}

/**
 * 构建 Voice Registry：角色名 → 音色 ID 映射（来自角色资产卡 voiceId 字段）。
 * 仅 hybrid 策略下生效；未注册音色的角色回退默认音色。
 */
function buildVoiceRegistry(
  db: DatabaseSync,
  projectId: string,
): Map<string, string> {
  const registry = new Map<string, string>();
  if (getAudioStrategy() !== 'hybrid') return registry;
  const characters = listAssetsByProject(db, projectId, 'character');
  for (const asset of characters) {
    if (asset.voiceId) {
      registry.set(asset.name, asset.voiceId);
    }
  }
  return registry;
}

/**
 * 配音与字幕：为每个分镜生成旁白音频，合并为整片旁白，生成 SRT 字幕。
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
    const audioDir = resolve(STORAGE_DIR, 'audio', projectId);
    mkdirSync(audioDir, { recursive: true });

    const ttsVoice = process.env.TTS_VOICE;
    // Voice Registry：hybrid 策略下主角音色跨集锁定（角色资产卡 voiceId）
    const voiceRegistry = buildVoiceRegistry(db, projectId);
    const segmentDurations: Array<{ narration: string; duration: number }> = [];
    const audioPaths: string[] = [];

    for (const seg of segments) {
      const narration = seg.prompt?.narration ?? seg.sourceText;
      const audioPath = resolve(audioDir, `${seg.id}_v${seg.currentVersion}.mp3`);
      // 主角音色：按块内出场角色查 Voice Registry，未注册回退默认音色
      let segVoice = ttsVoice;
      if (voiceRegistry.size > 0 && seg.characterNames.length > 0) {
        const registered = seg.characterNames.find((name) => voiceRegistry.has(name));
        if (registered) {
          segVoice = voiceRegistry.get(registered);
        }
      }
      if (!existsSync(audioPath)) {
        await generateAudio(narration, audioPath, segVoice);
      }
      const duration = await getAudioDuration(audioPath);
      segmentDurations.push({ narration, duration });
      audioPaths.push(audioPath);

      // 更新分镜时长为实际音频时长
      db.prepare('UPDATE video_segments SET estimated_seconds = ? WHERE id = ?').run(duration, seg.id);
    }

    // 合并所有分镜音频为整片旁白
    const narrationFullPath = resolve(audioDir, 'narration_full.mp3');
    await concatAudioFiles(audioPaths, narrationFullPath);

    // 生成 SRT 字幕
    const srtPath = resolve(audioDir, 'subtitles.srt');
    generateSRT(segmentDurations, srtPath);

    updateJob(db, job.id, {
      status: 'succeeded',
    });
    console.log(
      `[tts] project ${projectId} done, ${segments.length} audio files, narration: ${narrationFullPath}, srt: ${srtPath}`,
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
