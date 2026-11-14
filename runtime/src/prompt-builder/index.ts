import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLMAsJSON } from '../llm/gateway';
import {
  getProject,
  listSegmentsByProject,
  updateSegment,
  transitionSegmentStatus,
  transitionProjectStatus,
} from '../store';
import type { PromptBundle, StyleTemplate } from '../types';

const TEMPLATES_DIR = resolve(
  fileURLToPath(new URL('./templates', import.meta.url)),
);

interface StyleTemplateConfig {
  visualSuffix: string;
  negative: string;
  cameraGuide: string;
  subtitleStyle: string;
  narrationGuide: string;
}

function parseTemplate(md: string): StyleTemplateConfig {
  const extract = (header: string): string => {
    const regex = new RegExp(`## ${header}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = md.match(regex);
    return match ? match[1].trim() : '';
  };
  return {
    visualSuffix: extract('Visual 风格后缀'),
    negative: extract('负面提示词'),
    cameraGuide: extract('镜头语言指引'),
    subtitleStyle: extract('字幕样式'),
    narrationGuide: extract('旁白风格'),
  };
}

const templateCache = new Map<StyleTemplate, StyleTemplateConfig>();

function getTemplate(style: StyleTemplate): StyleTemplateConfig {
  if (templateCache.has(style)) return templateCache.get(style)!;
  const filename =
    style === 'motion-comic' ? 'motion-comic.md' : `${style}.md`;
  const filepath = resolve(TEMPLATES_DIR, filename);
  const md = readFileSync(filepath, 'utf-8');
  const config = parseTemplate(md);
  templateCache.set(style, config);
  return config;
}

interface LLMPromptResult {
  camera: string;
  visual: string;
  narration: string;
  subtitle: string;
}

const SYSTEM_PROMPT = `你是一个专业的 AI 视频提示词工程师。你的任务是为小说分镜生成结构化的视频生成提示词包。

输出格式：JSON 对象，包含以下字段：
- camera: 镜头语言描述（中文，如『中近景，缓慢推进，强调人物表情』）
- visual: 英文画面提示词，必须包含风格后缀，人物分镜必须包含角色外貌描述锚点
- narration: 中文旁白文本（基于分镜原文精简为 15~50 字）
- subtitle: 中文字幕文本（与旁白一致或精简版）

规则：
1. visual 必须是英文
2. visual 必须包含给定的风格后缀
3. 如果分镜包含角色（characterNames 非空），visual 必须包含角色的外貌描述锚点（从原文提取）
4. narration 按旁白语速 4~5 字/秒控制长度，对应 estimatedSeconds
5. subtitle 与 narration 内容一致，可适当精简`;

/**
 * 为单个分镜生成 PromptBundle。
 */
async function buildPromptForSegment(
  segment: {
    id: string;
    sourceText: string;
    sceneSummary: string;
    characterNames: string[];
    emotion: string;
    estimatedSeconds: number;
  },
  template: StyleTemplateConfig,
): Promise<PromptBundle> {
  const userPrompt = `请为以下分镜生成提示词包：

分镜原文：${segment.sourceText}
场景摘要：${segment.sceneSummary}
角色：${segment.characterNames.length > 0 ? segment.characterNames.join('、') : '无'}
情绪：${segment.emotion}
预计时长：${segment.estimatedSeconds} 秒

风格后缀（必须包含在 visual 末尾）：${template.visualSuffix}
镜头语言指引：${template.cameraGuide}
旁白风格指引：${template.narrationGuide}
字幕样式：${template.subtitleStyle}`;

  const result = await callLLMAsJSON<LLMPromptResult>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    temperature: 0.4,
  });

  return {
    camera: result.camera,
    visual: result.visual,
    negative: template.negative,
    narration: result.narration,
    subtitle: result.subtitle,
  };
}

/**
 * 批量构建提示词：为项目所有 draft 分镜生成 PromptBundle。
 * 项目状态：planning → prompt_building → planning（完成后回到可审阅状态）。
 * 分镜状态：draft → prompt_ready。
 */
export async function buildPrompts(
  db: DatabaseSync,
  projectId: string,
): Promise<void> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const segments = listSegmentsByProject(db, projectId);
  const draftSegments = segments.filter((s) => s.status === 'draft');
  if (draftSegments.length === 0) {
    throw new Error('没有 draft 状态的分镜可构建提示词');
  }

  const template = getTemplate(project.style);

  // 项目状态：planning → prompt_building
  transitionProjectStatus(db, projectId, 'prompt_building');

  try {
    for (const segment of draftSegments) {
      const promptBundle = await buildPromptForSegment(segment, template);
      updateSegment(db, segment.id, { prompt: promptBundle });
      transitionSegmentStatus(db, segment.id, 'prompt_ready');
    }

    // 项目状态回流：prompt_building → planning
    transitionProjectStatus(db, projectId, 'planning');
  } catch (err) {
    try {
      transitionProjectStatus(db, projectId, 'failed');
    } catch {
      // 忽略状态流转错误
    }
    throw err;
  }
}
