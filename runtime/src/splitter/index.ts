/**
 * 叙事块拆分（v1.1）：将剧本（或小说原文）拆分为 30 秒叙事块。
 *
 * 升级要点（对齐 Higgsfield 方法论与 30s 单次生成能力）
 * - 每块 15~30 秒（优先接近 30s），是一个完整戏剧单元：钩子 → 发展 → 落点
 * - 块内 6~9 个按秒分解的镜头（ShotPlan），一次生成整块
 * - 相邻镜头景别不重复；双人对话标注轴线锁定
 * - 每块标注 shotClass，供模型路由器选择生成模型
 * - 优先使用剧本化改写层（screenplay）的产出作为输入，未改写时回退 rawText
 */
import type { DatabaseSync } from 'node:sqlite';
import { callLLMAsJSON } from '../llm/gateway';
import { getProject, transitionProjectStatus, replaceProjectSegments } from '../store';
import type { CreateSegmentInput } from '../store';
import type { ShotClass, ShotPlan } from '../types';

/** LLM 返回的单个叙事块结构 */
interface LLMBlock {
  sourceText: string;
  sceneSummary: string;
  characterNames: string[];
  emotion: string;
  estimatedSeconds: number;
  event: string;
  characterState: string;
  nextSceneHint: string;
  shots: Array<{
    shotNo: number;
    timeRange: string;
    shotType: string;
    cameraMovement: string;
    fov?: string;
    action: string;
  }>;
  shotClass: ShotClass;
  axisLock: string;
}

const SYSTEM_PROMPT = `你是一个专业的小说转视频分镜师。你的任务是将剧本（或小说文本）拆分为 30 秒叙事块，每块一次视频生成。

拆分规则：
1. 一个叙事块对应一次视频生成，时长 15~30 秒（优先接近 30 秒），是一个完整戏剧单元：钩子 → 发展 → 落点
2. 场景切换（地点/时间变化）必须切分
3. 每块内部分镜 6~9 个镜头，每个镜头标注精确时间码（如 '0-3s'），所有镜头时长之和等于块时长
4. 相邻镜头景别不得相同（never two of the same shot size in a row）
5. 每块的 sourceText 必须是输入文本的连续切片，所有块的 sourceText 按顺序拼接后能还原全文（允许标点差异）
6. characterNames 提取该块中出现的角色名（无人时为空数组）
7. emotion 用一个词概括该块的情绪基调（如：紧张、温馨、悲伤、激昂、平静）
8. event 用一句话概括该块发生的核心动作（15 字以内）
9. characterState 描述主要人物在本块的状态（情绪/动作/位置，20 字以内；无人时为空字符串）
10. nextSceneHint 描述与下一个块的衔接点（场景/视线/动作延续，20 字以内；最后一个块为空字符串）
11. shots 数组：每个镜头含 shotNo（从 1 开始）、timeRange（如 '0-3s'）、shotType（空镜/近景/中近景/中景/远景/特写）、cameraMovement（固定/微推/缓摇/跟拍/升降）、fov（FOV 数值如 '47°'，可选）、action（该镜头动作描述，30 字以内）
12. shotClass 标注该块类型：dialogue（对话为主）/ performance（表演为主）/ vfx（特效奇观）/ broll（空镜转场）/ draft（草稿）
13. axisLock 轴线锁定：双人以上对话场景标注角色屏幕方位（如『甲 frame-left, 乙 frame-right』）；单人或空镜为空字符串

输出格式：JSON 对象，包含 segments 数组，每项含 sourceText、sceneSummary、characterNames、emotion、estimatedSeconds、event、characterState、nextSceneHint、shots、shotClass、axisLock。`;

/** 校验并规范化 LLM 返回的镜头计划 */
function normalizeShots(raw: unknown): ShotPlan[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, i) => ({
      shotNo: Number(s.shotNo) || i + 1,
      timeRange: String(s.timeRange ?? ''),
      shotType: String(s.shotType ?? ''),
      cameraMovement: String(s.cameraMovement ?? ''),
      fov: s.fov ? String(s.fov) : undefined,
      action: String(s.action ?? ''),
    }))
    .filter((s) => s.timeRange && s.action);
}

const VALID_SHOT_CLASSES: ReadonlySet<string> = new Set([
  'dialogue',
  'performance',
  'vfx',
  'broll',
  'draft',
]);

/**
 * 叙事块拆分：将剧本（优先）或小说原文拆分为 30s 叙事块，写入 video_segments。
 * 项目状态：planning → splitting → planning（完成后回到可审阅状态）。
 */
export async function splitText(db: DatabaseSync, projectId: string): Promise<void> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  // 输入选择：优先使用剧本化改写结果（可拍摄内容），未改写时回退小说原文
  const screenplay = project.novelSource.screenplay;
  let inputText: string;
  let contextBlock = '';
  if (screenplay?.scenes?.length) {
    inputText = screenplay.scenes.map((s) => s.content).join('\n\n');
    const sceneMeta = screenplay.scenes
      .map(
        (s) =>
          `- 场${s.sceneNo} ${s.location}｜${s.timeOfDay}｜光源：${s.lighting}｜${s.characters.join('、') || '无角色'}｜${s.emotion}`,
      )
      .join('\n');
    contextBlock = `\n\n分场剧本元信息（拆分时保持场景边界与灯光/时间设定一致）：\n${sceneMeta}`;
  } else {
    const rawText = project.novelSource.rawText;
    if (!rawText || rawText.trim().length === 0) {
      throw new Error('项目没有小说文本（novelSource.rawText 为空）');
    }
    inputText = rawText;
  }

  // 状态流转：planning → splitting
  transitionProjectStatus(db, projectId, 'splitting');

  try {
    const result = await callLLMAsJSON<{ segments: LLMBlock[] }>({
      system: SYSTEM_PROMPT,
      user: `请将以下文本拆分为 30 秒叙事块：${contextBlock}\n\n输入文本：\n${inputText}`,
      temperature: 0.3,
    });

    const segments = result.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('LLM 返回的叙事块列表为空或格式错误');
    }

    // 转换为 CreateSegmentInput 并写入数据库
    const inputs: CreateSegmentInput[] = segments.map((seg, index) => {
      const shotClass = VALID_SHOT_CLASSES.has(String(seg.shotClass))
        ? (seg.shotClass as ShotClass)
        : 'dialogue';
      return {
        projectId,
        order: index + 1,
        sourceText: seg.sourceText,
        sceneSummary: seg.sceneSummary,
        characterNames: Array.isArray(seg.characterNames) ? seg.characterNames : [],
        emotion: seg.emotion ?? '平静',
        // 30s 叙事块：钳制在 15~30 秒
        estimatedSeconds: Math.max(15, Math.min(30, Number(seg.estimatedSeconds) || 30)),
        event: seg.event ?? seg.sceneSummary ?? '',
        characterState: seg.characterState ?? '',
        nextSceneHint: seg.nextSceneHint ?? '',
        shots: normalizeShots(seg.shots),
        shotClass,
        axisLock: seg.axisLock ?? '',
      };
    });

    replaceProjectSegments(db, projectId, inputs);

    // 状态回流：splitting → planning（回到可审阅状态）
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
