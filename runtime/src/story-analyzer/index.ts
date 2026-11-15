/**
 * N1 文本解析节点：LLM 全文理解。
 * 输出 story profile（题材/风格/主线/人物关系），存入 video_projects.novel_source.storyProfile，
 * 供后续切片（N2）、提示词构建（N7）复用全局上下文，保证跨分镜一致性。
 */
import type { DatabaseSync } from 'node:sqlite';
import { callLLMAsJSON } from '../llm/gateway';
import { getProject, updateProject } from '../store';
import type { VideoProject } from '../types';

/** 故事档案：全片级上下文 */
export interface StoryProfile {
  /** 题材（如：玄幻/都市/科幻/悬疑） */
  genre: string;
  /** 叙事风格（如：热血/沉稳/诙谐/悲壮） */
  narrativeTone: string;
  /** 主线概述（50 字以内） */
  mainPlot: string;
  /** 主要人物及其关系 */
  characters: Array<{
    name: string;
    /** 在故事中的角色（主角/配角/反派等） */
    role: string;
    /** 与其他人物的关系简述 */
    relations: string;
    /** 视觉锚点：贯穿全片的外形特征（发型/服装/标志性道具） */
    visualAnchor: string;
  }>;
  /** 世界观/时代背景（20 字以内） */
  worldSetting: string;
  /** 建议的视觉风格关键词（英文，用于注入 visual prompt） */
  visualStyleHint: string;
}

const SYSTEM_PROMPT = `你是一个专业的小说文本分析师。你的任务是通读小说文本，提炼全片级的故事档案，供后续视频生成保持跨镜头一致性。

输出 JSON 对象，包含以下字段：
- genre: 题材分类（如：玄幻/都市/科幻/悬疑/武侠/言情，一个词）
- narrativeTone: 叙事基调（如：热血/沉稳/诙谐/悲壮/悬疑，一个词）
- mainPlot: 主线概述（50 字以内）
- characters: 主要人物数组（最多 5 个），每项含：
  - name: 人物名
  - role: 故事角色（主角/配角/反派/导师等）
  - relations: 与其他人物的关系（20 字以内）
  - visualAnchor: 贯穿全片的外形特征（发型/服装/标志性道具，用于视频生成保持人物形象一致，30 字以内）
- worldSetting: 世界观/时代背景（20 字以内）
- visualStyleHint: 建议的英文视觉风格关键词（如 "wuxia fantasy, misty mountains, golden light effects"）

规则：
1. 只提取有名字的人物，群众不提取
2. visualAnchor 必须具体、可视化，避免抽象描述
3. 所有字段必填，无人物时 characters 为空数组`;

/**
 * 把 PiNovelStudio 推送的结构化上下文（大纲/人物卡/种子）格式化为 prompt 文本块。
 * 无上下文时返回空字符串（保持原有行为）。
 */
function buildContextBlock(ctx: VideoProject['novelSource']['novelContext']): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.outline && ctx.outline.length > 0) {
    const lines = ctx.outline
      .map((n) => `- ${n.title}${n.summary ? `：${n.summary}` : ''}`)
      .join('\n');
    parts.push(`【原作大纲】\n${lines}`);
  }
  if (ctx.characters && ctx.characters.length > 0) {
    const lines = ctx.characters
      .map(
        (c) =>
          `- ${c.name}（${c.roleType || '角色'}）${c.identity ? `：${c.identity}` : ''}${c.personality ? `；性格：${c.personality}` : ''}${c.relationships ? `；关系：${c.relationships}` : ''}`,
      )
      .join('\n');
    parts.push(
      `【原作人物卡（优先采用，visualAnchor 需基于这些设定具体化，不要凭空想象）】\n${lines}`,
    );
  }
  if (ctx.seed && (ctx.seed.intent || ctx.seed.mustInclude || ctx.seed.endingGoal)) {
    const seedLines = [
      ctx.seed.intent ? `- 本章意图：${ctx.seed.intent}` : '',
      ctx.seed.mustInclude ? `- 必须包含：${ctx.seed.mustInclude}` : '',
      ctx.seed.endingGoal ? `- 结局目标：${ctx.seed.endingGoal}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    parts.push(`【章节种子】\n${seedLines}`);
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n\n` : '';
}

/**
 * 文本解析：生成 story profile 并写入项目 novel_source.storyProfile。
 * 不流转项目状态（解析是 planning 状态下的准备工作）。
 */
export async function analyzeStory(
  db: DatabaseSync,
  projectId: string,
): Promise<StoryProfile> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  const rawText = project.novelSource.rawText;
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('项目没有小说文本（novelSource.rawText 为空）');
  }

  const contextBlock = buildContextBlock(project.novelSource.novelContext);
  const profile = await callLLMAsJSON<StoryProfile>({
    system: SYSTEM_PROMPT,
    user: `${contextBlock}请分析以下小说文本，输出故事档案：\n\n${rawText}`,
    temperature: 0.3,
  });

  // 规范化：保证字段存在
  const normalized: StoryProfile = {
    genre: profile.genre ?? '未知',
    narrativeTone: profile.narrativeTone ?? '沉稳',
    mainPlot: profile.mainPlot ?? '',
    characters: Array.isArray(profile.characters)
      ? profile.characters.slice(0, 5).map((c) => ({
          name: c.name ?? '',
          role: c.role ?? '配角',
          relations: c.relations ?? '',
          visualAnchor: c.visualAnchor ?? '',
        }))
      : [],
    worldSetting: profile.worldSetting ?? '',
    visualStyleHint: profile.visualStyleHint ?? '',
  };

  // 写入 novel_source.storyProfile（保留原有 chapterIds/rawText）
  updateProject(db, projectId, {
    novelSource: {
      ...project.novelSource,
      storyProfile: normalized,
    } as typeof project.novelSource,
  });

  console.log(
    `[story-analyzer] project=${projectId} genre=${normalized.genre} characters=${normalized.characters.length}`,
  );
  return normalized;
}
