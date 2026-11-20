/**
 * 提示词构建器（v1.1）：12 模块结构化提示词（Higgsfield 框架）。
 *
 * 升级要点：
 * - LLM 按模块输出：SCENE CONTEXT / ACTIVE REFERENCES / LOCATION MAP /
 *   FIRST FRAME & BLOCKING / FORMAT / OPTICS / CAMERA / ACTION TIMELINE /
 *   PHYSICS / LIGHTING / AUDIO / STYLE + NEGATIVE
 * - 注入角色圣经（资产卡外貌锚点，100% matches the reference 锁定）
 * - 注入场景圣经（色温/方向数值化灯光规格）
 * - 基于叙事块的镜头计划（shots）展开按秒分镜时间轴
 * - finalPrompt 组装 + 超长裁剪保护（优先保 actionTimeline/activeReferences/negative）
 * - 同时派生旧 PromptBundle（narration/subtitle 等），保持 worker/前端兼容
 */
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLMAsJSON } from '../llm/gateway';
import {
  getProject,
  listSegmentsByProject,
  listAssetsByProject,
  updateSegment,
  transitionSegmentStatus,
  transitionProjectStatus,
} from '../store';
import type {
  AssetCard,
  PromptBundle,
  PromptBundleV2,
  Segment,
  StyleTemplate,
} from '../types';

const TEMPLATES_DIR = resolve(
  fileURLToPath(new URL('./templates', import.meta.url)),
);

interface StyleTemplateConfig {
  visualSuffix: string;
  negative: string;
  cameraGuide: string;
  subtitleStyle: string;
  narrationGuide: string;
  transitionType: string;
  transitionDuration: number;
  bgmStyle: string;
  bgmVolume: number;
  globalQualitySuffix: string;
}

function parseTemplate(md: string): StyleTemplateConfig {
  const extract = (header: string): string => {
    const regex = new RegExp(`## ${header}\n([\s\S]*?)(?=\n## |$)`);
    const match = md.match(regex);
    return match ? match[1].trim() : '';
  };
  return {
    visualSuffix: extract('Visual 风格后缀'),
    negative: extract('负面提示词'),
    cameraGuide: extract('镜头语言指引'),
    subtitleStyle: extract('字幕样式'),
    narrationGuide: extract('旁白风格'),
    transitionType: extract('转场配置') || 'fade',
    transitionDuration: parseFloat(extract('转场配置')?.match(/[\d.]+/)?.[0] ?? '0.5'),
    bgmStyle: extract('配乐基调') || 'ambient',
    bgmVolume: parseFloat(extract('配乐基调')?.match(/音量[：:]\s*([\d.]+)/)?.[1] ?? '0.3'),
    globalQualitySuffix: extract('全局质量后缀'),
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

/** 12 模块类型 */
type PromptModules = PromptBundleV2['modules'];

/** LLM 返回结构：12 模块（英文）+ 兼容字段（中文） */
interface LLMPromptResultV2 {
  modules: PromptModules;
  negative: string;
  narration: string;
  subtitle: string;
  cameraZh: string;
  lipSync: 'speak' | 'inner' | 'none';
}

const SYSTEM_PROMPT = `你是顶级 AI 视频提示词工程师，精通电影级镜头语言。你的任务是为 30 秒叙事块生成 12 模块结构化提示词（Higgsfield 框架）。

输出 JSON 对象：
modules（全部英文，供视频模型直接使用）：
- sceneContext: 场景背景（必须以给定场景圣经的场景名为准统一描述，同一场景跨块措辞一致；地点/人物/事件/情绪弧线/整体形式：一镜到底或多镜头）
- activeReferences: 参考锁定（每个出场角色：@角色名: 外貌逐项描述。100% matches the reference, fully consistent in every shot.）
- locationMap: 场景地图（物理空间逐项：地面/两侧/远景/天空/道具/人员状态）
- firstFrameBlocking: 首帧与空间调度（精确构图 + 屏幕坐标如 at x40% frame left + 轴线规则）
- formatMode: 拍摄格式（一镜到底/多镜头、画幅、fps、剪辑点落点）
- optics: 光学（FOV 数值化如 47° standard、对焦规则、景深）
- camera: 摄影机（手持质感/运动路径量化，如 natural breathing sway, no gimbal smoothness）
- actionTimeline: 分镜时间轴（按秒分解，基于给定镜头计划展开，每镜头含时间码/景别/运镜/动作）
- physics: 物理真实感（重量/惯性/滞后，如 hair lags and settles, fabric carries brief inertia, impacts carry real mass）
- lighting: 灯光（色温数值化如 1900K candlelight + 7500K moonlight、光源方向、跨镜头一致）
- audio: 声音（对白必须保留原文语言（中文）一字不译，情感指示与 [breath] 标记用英文；环境音分层、音效、是否 NO MUSIC）
- style: 风格（胶片质感 + 调色 + 画质法则）
negative: 负面清单（英文，以给定负面清单为基础可追加）
narration: 中文旁白（基于原文精简，按 4~5 字/秒 × 块时长控制字数；对白密集块只写极简转场衔接句或留空，台词交给画面内角色原声，避免第三方解说感）
subtitle: 中文字幕（与旁白一致或精简）
cameraZh: 中文镜头语言描述（如『中近景，缓慢推进，强调人物表情』）
lipSync: 口型模式（speak=说话有口型/inner=内心独白嘴唇闭合/none=无台词）

规则：
1. modules 与 negative 全部英文，但对白（dialogue）必须保留原文语言（中文）一字不译；narration/subtitle/cameraZh 中文
2. actionTimeline 必须基于给定镜头计划（shots）展开，时间码精确到秒，所有镜头时长之和等于块时长；相邻镜头景别不得相同
3. activeReferences 必须包含给定角色卡的外貌锚点描述，逐项列出
4. lighting 优先采用给定场景圣经的色温/方向设定，数值化
5. style 必须包含给定风格后缀与全局质量后缀
6. firstFrameBlocking 必须遵守给定轴线锁定（axisLock）
7. 对白必须保留原文语言（中文）一字不译，禁止翻译成英文或其他语言；情感指示用英文标注（如 (quiet, restrained)），带 [breath] 等呼吸标记。角色名首次出现用中英并用（如 Lin Yi (林逸)）
8. sceneContext 与 locationMap 必须基于给定场景圣经的场景名与描述展开，同一场景在所有块中保持完全一致的地点描述与视觉基调，禁止自行演绎新地点`;

/** 模块顺序与标题（finalPrompt 组装用） */
const MODULE_TITLES: Array<{ key: keyof PromptModules; title: string }> = [
  { key: 'sceneContext', title: 'SCENE CONTEXT' },
  { key: 'activeReferences', title: 'ACTIVE REFERENCES' },
  { key: 'locationMap', title: 'LOCATION MAP' },
  { key: 'firstFrameBlocking', title: 'FIRST FRAME & BLOCKING' },
  { key: 'formatMode', title: 'FORMAT' },
  { key: 'optics', title: 'OPTICS' },
  { key: 'camera', title: 'CAMERA' },
  { key: 'actionTimeline', title: 'ACTION TIMELINE' },
  { key: 'physics', title: 'PHYSICS' },
  { key: 'lighting', title: 'LIGHTING' },
  { key: 'audio', title: 'AUDIO' },
  { key: 'style', title: 'STYLE' },
];

/** finalPrompt 预算（字符数，约 6000 token） */
const MAX_FINAL_PROMPT_CHARS = 24000;

/** 裁剪优先级（从低到高）：超长时从最低优先级模块开始截断 */
const TRIM_ORDER: Array<keyof PromptModules> = [
  'style',
  'formatMode',
  'firstFrameBlocking',
  'locationMap',
  'camera',
  'optics',
  'physics',
  'audio',
  'lighting',
  'sceneContext',
];

function assembleFinalPrompt(modules: PromptModules, negative: string): string {
  const parts = MODULE_TITLES.map(({ key, title }) => `${title}: ${modules[key]}`);
  // 字幕自动化（v1.1）：画面声明不出现任何文字，字幕由系统按分镜脚本+时间码生成 SRT 交付
  const negativeWithNoText = `${negative}, no text, no subtitles, no captions, no watermarks, no on-screen graphics`;
  parts.push(`NEGATIVE: ${negativeWithNoText}`);
  return parts.join('\n\n');
}

/** 超长保护：按优先级截断低优先级模块，优先保 actionTimeline/activeReferences/negative */
function fitModulesToBudget(modules: PromptModules): PromptModules {
  let fitted: PromptModules = { ...modules };
  let i = 0;
  while (
    assembleFinalPrompt(fitted, fitted.audio).length > MAX_FINAL_PROMPT_CHARS &&
    i < TRIM_ORDER.length
  ) {
    const key = TRIM_ORDER[i];
    const original = fitted[key] ?? '';
    fitted = { ...fitted, [key]: `${original.slice(0, 300)} ...` };
    i++;
  }
  return fitted;
}

/** 规范化 LLM 返回的模块（缺失字段兜底） */
function normalizeModules(raw: Partial<PromptModules> | undefined): PromptModules {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    sceneContext: str(raw?.sceneContext),
    activeReferences: str(raw?.activeReferences),
    locationMap: str(raw?.locationMap),
    firstFrameBlocking: str(raw?.firstFrameBlocking),
    formatMode: str(raw?.formatMode),
    optics: str(raw?.optics),
    camera: str(raw?.camera),
    actionTimeline: str(raw?.actionTimeline),
    physics: str(raw?.physics),
    lighting: str(raw?.lighting),
    audio: str(raw?.audio),
    style: str(raw?.style),
  };
}

/**
 * 为单个叙事块生成 12 模块提示词（PromptBundleV2）+ 兼容旧 PromptBundle。
 */
async function buildPromptV2ForSegment(
  segment: Segment,
  template: StyleTemplateConfig,
  characterAssets: AssetCard[],
  sceneAssets: AssetCard[],
): Promise<{ v2: PromptBundleV2; legacy: PromptBundle }> {
  // 角色圣经：仅注入本块出场的角色
  const relevantChars = characterAssets.filter((a) =>
    segment.characterNames.includes(a.name),
  );
  const charBlock = relevantChars.length
    ? relevantChars
        .map((c) => `- ${c.name}：${c.description}`)
        .join('\n')
    : '（本块无角色或未建角色卡）';

  // 场景圣经：全部注入，LLM 按场景选用
  const sceneBlock = sceneAssets.length
    ? sceneAssets
        .map(
          (s) =>
            `- ${s.name}：${s.description}${s.lightingSpec ? `｜灯光规格：${s.lightingSpec}` : ''}${s.audioSpec ? `｜声音规格：${s.audioSpec}` : ''}`,
        )
        .join('\n')
    : '（未建场景卡）';

  // 镜头计划文本
  const shotsText = segment.shots?.length
    ? segment.shots
        .map(
          (s) =>
            `  Shot ${s.shotNo} (${s.timeRange}) [${s.shotType}/${s.cameraMovement}${s.fov ? `/${s.fov}` : ''}]: ${s.action}`,
        )
        .join('\n')
    : '（无预置镜头计划，请自行按秒分解 6~9 个镜头）';

  const userPrompt = `请为以下 30 秒叙事块生成 12 模块提示词：

叙事块原文：${segment.sourceText}
场景摘要：${segment.sceneSummary}
出场角色：${segment.characterNames.length > 0 ? segment.characterNames.join('、') : '无'}
情绪：${segment.emotion}
块时长：${segment.estimatedSeconds} 秒
核心事件：${segment.event}
人物状态：${segment.characterState || '无'}
轴线锁定：${segment.axisLock || '无'}
与下一块衔接：${segment.nextSceneHint || '无'}

镜头计划（actionTimeline 必须基于此展开）：
${shotsText}

角色圣经（activeReferences 必须逐项引用外貌锚点）：
${charBlock}

场景圣经（lighting 优先采用其色温/方向设定）：
${sceneBlock}

风格后缀（style 必须包含）：${template.visualSuffix}
全局质量后缀（style 必须包含）：${template.globalQualitySuffix}
镜头语言指引（camera 参考）：${template.cameraGuide}
负面清单基础（negative 以此为基础）：${template.negative}
旁白风格指引：${template.narrationGuide}
字幕样式：${template.subtitleStyle}`;

  const result = await callLLMAsJSON<LLMPromptResultV2>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    temperature: 0.4,
  });

  const modules = fitModulesToBudget(normalizeModules(result.modules));
  // activeReferences 兜底（v1.1.1）：LLM 漏填时强制注入角色圣经外貌锚点，保证人物一致性
  if (modules.activeReferences.length === 0 && relevantChars.length > 0) {
    modules.activeReferences = relevantChars
      .map((c) => '@' + c.name + ': ' + c.description + '. 100% matches the reference, fully consistent in every shot.')
      .join(String.fromCharCode(10));
  }
  // audio 对白强制校验（v1.1.2）：原文含中文对白而 audio 模块缺失时强制注入，
  // 修复 performance/dialogue 镜头 LLM 漏带台词导致视频无对白的问题（SEG1/SEG2 台词丢失根因）
  const dialogueTexts: string[] = [];
  const dialogueLines: string[] = [];
  for (const m of segment.sourceText.matchAll(
    /([一-龥]{1,6})[（(][^）)]{0,8}[）)][:：]\s*[“「"]?([^”」"\n]{2,})[”」"]?/g,
  )) {
    const text = m[2].trim();
    dialogueTexts.push(text);
    dialogueLines.push(`${m[1]}: 「${text}」`);
  }
  if (dialogueLines.length === 0) {
    for (const m of segment.sourceText.matchAll(/[“「"]([^”」"]{2,})[”」"]/g)) {
      const t = m[1].trim();
      if (/[一-龥]/.test(t)) {
        dialogueTexts.push(t);
        dialogueLines.push(`「${t}」`);
      }
    }
  }
  if (dialogueTexts.length > 0) {
    const dialoguePart =
      ' Dialogue (keep original Chinese, do not translate): ' + dialogueLines.join(' ');
    if (modules.audio.length === 0) {
      modules.audio =
        'NO MUSIC. Layered environment sound consistent with the scene.' + dialoguePart;
    } else if (!dialogueTexts.some((t) => modules.audio.includes(t))) {
      // audio 模块非空但未包含原文对白：追加注入，保证台词不丢失
      modules.audio = modules.audio + dialoguePart;
    }
  } else if (modules.audio.length === 0) {
    modules.audio = 'NO MUSIC. Layered environment sound consistent with the scene.';
  }
  const negative = (result.negative || template.negative).trim();
  const finalPrompt = assembleFinalPrompt(modules, negative);

  const v2: PromptBundleV2 = {
    modules,
    negative,
    finalPrompt,
  };

  // 派生旧 PromptBundle（保持 worker/前端兼容）
  const firstShot = segment.shots?.[0];
  const legacy: PromptBundle = {
    camera: result.cameraZh ?? '',
    visual: finalPrompt,
    negative,
    narration: result.narration ?? '',
    subtitle: result.subtitle ?? '',
    continuity: segment.nextSceneHint
      ? `衔接下一块：${segment.nextSceneHint}`
      : '',
    shotType: firstShot?.shotType ?? '',
    cameraMovement: firstShot?.cameraMovement ?? '',
    lipSync:
      result.lipSync === 'speak' || result.lipSync === 'inner' || result.lipSync === 'none'
        ? result.lipSync
        : 'none',
    soundDesign: modules.audio.slice(0, 300),
    globalQualitySuffix: template.globalQualitySuffix,
  };

  return { v2, legacy };
}

/**
 * 批量构建提示词：为项目所有 draft 叙事块生成 12 模块 PromptBundleV2 + 兼容 PromptBundle。
 * 项目状态：planning → prompt_building → planning（完成后回到可审阅状态）。
 * 叙事块状态：draft → prompt_ready。
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
  const characterAssets = listAssetsByProject(db, projectId, 'character');
  const sceneAssets = listAssetsByProject(db, projectId, 'scene');

  // 项目状态：planning → prompt_building
  transitionProjectStatus(db, projectId, 'prompt_building');

  try {
    for (const segment of draftSegments) {
      const { v2, legacy } = await buildPromptV2ForSegment(
        segment,
        template,
        characterAssets,
        sceneAssets,
      );
      updateSegment(db, segment.id, { prompt: legacy, promptV2: v2 });
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
