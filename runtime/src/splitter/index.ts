import type { DatabaseSync } from 'node:sqlite';
import { callLLMAsJSON } from '../llm/gateway';
import { getProject, transitionProjectStatus, replaceProjectSegments } from '../store';
import type { CreateSegmentInput } from '../store';

/** LLM 返回的单个分镜结构（N2 场景切片） */
interface LLMScene {
  sourceText: string;
  sceneSummary: string;
  characterNames: string[];
  emotion: string;
  estimatedSeconds: number;
  event: string;
  characterState: string;
  nextSceneHint: string;
}

const SYSTEM_PROMPT = `你是一个专业的小说转视频分镜师。你的任务是将小说章节文本拆分为连续的视频分镜。

拆分规则：
1. 一个分镜对应一个连续镜头，时长 4~5 秒（旁白约 18~25 字，按 4~5 字/秒估算）
2. 场景切换（地点/时间变化）必须切分
3. 最多拆 5 个分镜
4. 每个分镜的 sourceText 必须是原文的连续切片，所有分镜的 sourceText 按顺序拼接后能还原全文（允许标点差异）
5. characterNames 提取该分镜中出现的角色名（无人时为空数组）
6. emotion 用一个词概括该分镜的情绪基调（如：紧张、温馨、悲伤、激昂、平静）
7. estimatedSeconds 按旁白字数除以 4.5 估算，范围 4~5

8. event 用一句话概括该切片发生的核心动作（15 字以内）
9. characterState 描述主要人物在本切片的状态（情绪/动作/位置，20 字以内；无人时为空字符串）
10. nextSceneHint 描述与下一个切片的衔接点（场景/视线/动作延续，20 字以内；最后一个切片为空字符串）
输出格式：JSON 对象，包含 segments 数组，每项含 sourceText、sceneSummary、characterNames、emotion、estimatedSeconds、event、characterState、nextSceneHint。`;

/**
 * 文本拆分：将章节文本拆分为分镜列表，写入 video_segments。
 * 项目状态：planning → splitting → planning（完成后回到可审阅状态）。
 */
export async function splitText(db: DatabaseSync, projectId: string): Promise<void> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  const rawText = project.novelSource.rawText;
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('项目没有小说文本（novelSource.rawText 为空）');
  }

  // 状态流转：planning → splitting
  transitionProjectStatus(db, projectId, 'splitting');

  try {
    const result = await callLLMAsJSON<{ segments: LLMScene[] }>({
      system: SYSTEM_PROMPT,
      user: `请将以下小说文本拆分为视频分镜：\n\n${rawText}`,
      temperature: 0.3,
    });

    const segments = result.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('LLM 返回的分镜列表为空或格式错误');
    }

    // 转换为 CreateSegmentInput 并写入数据库
    const inputs: CreateSegmentInput[] = segments.map((seg, index) => ({
      projectId,
      order: index + 1,
      sourceText: seg.sourceText,
      sceneSummary: seg.sceneSummary,
      characterNames: Array.isArray(seg.characterNames) ? seg.characterNames : [],
      emotion: seg.emotion ?? '平静',
      estimatedSeconds: Math.max(4, Math.min(5, Number(seg.estimatedSeconds) || 5)),
      event: seg.event ?? seg.sceneSummary ?? '',
      characterState: seg.characterState ?? '',
      nextSceneHint: seg.nextSceneHint ?? '',
    }));

    replaceProjectSegments(db, projectId, inputs);

    // 状态回流：splitting → planning（回到可审阅状态）
    // planning 允许流转到 splitting 或 failed，splitting 完成后回到 planning
    // 以便后续 asset_extracting / prompt_building
    transitionProjectStatus(db, projectId, 'planning');
  } catch (err) {
    // 失败时标记项目失败
    try {
      transitionProjectStatus(db, projectId, 'failed');
    } catch {
      // 状态可能已经不是 splitting，忽略
    }
    throw err;
  }
}
