/**
 * 剧本化改写层：将小说文本改写为可直接拍摄的分场剧本。
 *
 * 设计理念：小说不是剧本，视频不是文字的直译。
 * 叙述性文字（如『她很伤心』）必须改写为可拍摄的内容
 * （如『她背对镜头，肩膀微微颤抖，一滴泪落在信纸上』）。
 *
 * 改写后的剧本作为后续叙事块拆分和提示词生成的输入，
 * 替代直接使用 rawText。
 */
import type { DatabaseSync } from 'node:sqlite';
import { callLLMAsJSON } from '../llm/gateway';
import { getProject, updateProject } from '../store';
import type { Screenplay, ScreenplayScene } from '../types';

// 类型定义统一收敛到 ../types（v1.1），此处 re-export 保持模块对外 API 兼容
export type { Screenplay, ScreenplayScene };

const SYSTEM_PROMPT = `你是专业影视编剧。你的任务是将小说文本改写为可直接拍摄的分场剧本。

改写规则：
1. 所有叙述性心理描写必须转化为可见动作/表情/环境反应。
   反例：『她很伤心』
   正例：『她背对镜头，肩膀微微颤抖，一滴泪落在信纸上』
2. 对白保留原文，并标注情感指示（如：低声、颤抖、压抑怒意），格式为：角色名（情感指示）：台词
3. 每场标注：location（地点）、timeOfDay（时间，如清晨/深夜/黄昏）、lighting（光源方向+色温，如『左侧窗光 5600K』）、characters（在场角色名列表）、emotion（情绪基调，一个词）
4. 每场是一个完整戏剧单元：钩子 → 发展 → 落点
5. 不增删情节，只改写表达方式。所有场景的 sourceText 按顺序拼接后能还原原文（允许标点差异）
6. 场景切换（地点/时间变化）必须分场

输出格式：JSON 对象，包含 scenes 数组，每项含 sceneNo（从 1 开始）、location、timeOfDay、lighting、characters（字符串数组）、emotion、content（可拍摄的剧本正文）、sourceText（对应原文连续切片）。`;

/**
 * 剧本化改写：将项目的小说原文改写为分场剧本，存入项目。
 * 改写结果存放在 novelSource.screenplay 字段（VideoProject 扩展）。
 */
export async function adaptScreenplay(db: DatabaseSync, projectId: string): Promise<Screenplay> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  const rawText = project.novelSource.rawText;
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('项目没有小说文本（novelSource.rawText 为空）');
  }

  // 组装用户输入：优先使用 PiNovelStudio 的结构化上下文
  const novelContext = project.novelSource.novelContext;
  let contextBlock = '';
  if (novelContext?.characters && novelContext.characters.length > 0) {
    const chars = novelContext.characters
      .map((c) => `- ${c.name}${c.identity ? `（${c.identity}）` : ''}${c.personality ? `：${c.personality}` : ''}`)
      .join('\n');
    contextBlock += `\n\n原作人物卡（优先采用其设定）：\n${chars}`;
  }
  if (novelContext?.outline && novelContext.outline.length > 0) {
    const nodes = novelContext.outline
      .map((n) => `- ${n.title}${n.summary ? `：${n.summary}` : ''}`)
      .join('\n');
    contextBlock += `\n\n大纲节点：\n${nodes}`;
  }

  const userPrompt = `请将以下小说文本改写为分场剧本：${contextBlock}\n\n小说原文：\n${rawText}`;

  const result = await callLLMAsJSON<Screenplay>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  if (!result.scenes || !Array.isArray(result.scenes) || result.scenes.length === 0) {
    throw new Error('剧本化改写失败：LLM 未返回 scenes 数组');
  }

  // 校验：所有场景 sourceText 拼接应覆盖原文（宽松校验，允许标点差异）
  const merged = result.scenes.map((s) => s.sourceText ?? '').join('');
  const normalized = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, '');
  const coverage = normalized(merged).length / Math.max(normalized(rawText).length, 1);
  if (coverage < 0.85) {
    console.warn(
      `[screenplay] sourceText 覆盖率 ${(coverage * 100).toFixed(1)}%，可能存在情节丢失`,
    );
  }

  // 存入项目（VideoProject.novelSource 扩展 screenplay 字段）
  updateProject(db, projectId, {
    novelSource: {
      ...project.novelSource,
      screenplay: result,
    } as typeof project.novelSource,
  });

  console.log(
    `[screenplay] projectId=${projectId} scenes=${result.scenes.length} coverage=${(coverage * 100).toFixed(1)}%`,
  );
  return result;
}
