/**
 * 资产提取（v1.1）：升级为角色圣经 / 场景圣经。
 *
 * 升级要点：
 * - 角色卡结构化：外貌逐项（发型/发色/瞳色/五官/体态/服装/配饰）+ 气质关键词
 * - 场景卡圣经化：灯光规格（光源方向+色温数值化，如『左侧窗光 5600K』）+ 声音规格
 * - scope 层级：默认 project（集级）；剧集级共享资产由上层标记为 series
 * - 提示词构建时强制注入 100% matches the reference 锁定（见 prompt-builder）
 */
import type { DatabaseSync } from 'node:sqlite';
import { callLLMAsJSON } from '../llm/gateway';
import {
  getProject,
  transitionProjectStatus,
  createAsset,
  listAssetsByProject,
  deleteAsset,
} from '../store';
import type { AssetKind, VideoProject } from '../types';

interface LLMCharacterCard {
  name: string;
  appearance: string;
  hair: string;
  eyes: string;
  build: string;
  clothing: string;
  accessories: string;
  temperament: string;
}

interface LLMSceneCard {
  name: string;
  location: string;
  lightingSpec: string;
  audioSpec: string;
  props: string;
}

interface LLMAssetResult {
  characters: LLMCharacterCard[];
  scenes: LLMSceneCard[];
}

const SYSTEM_PROMPT = `你是一个专业的小说资产提取器。你的任务是从小说章节文本中提取角色圣经卡和场景圣经卡。

角色卡字段（外貌必须逐项具体，可直接用于画面生成与跨镜头锁定）：
- name: 角色名
- appearance: 五官与肤质描述
- hair: 发型与发色（如『黑色长发，低马尾，碎发刘海』）
- eyes: 瞳色与眼神（如『深棕色，眼神锐利』）
- build: 体态（如『高挑清瘦，肩背挺直』）
- clothing: 服装逐项（上装/下装/鞋/外套，如『白色立领衬衫，深灰西裤，黑色皮鞋』）
- accessories: 配饰（如『银色细链项链，左手腕表』；无则空字符串）
- temperament: 气质关键词（2~4 个词）

场景卡字段（灯光规格必须数值化，供跨块灯光一致性锁定）：
- name: 场景名
- location: 地点与空间描述
- lightingSpec: 灯光规格（光源方向+色温+光质，如『左侧窗光 5600K 柔光，室内暖灯 3000K 补光，高对比』）
- audioSpec: 声音规格（环境音分层，如『雨声持续，远处雷声，室内翻纸声』）
- props: 关键道具

规则：
1. 只提取有名字的角色，群众不提取
2. 场景按地点切换提取，不重复
3. 角色外貌必须从原文提取并具体化；原文未提及的项基于人设合理推断，不留空
4. 灯光规格必须包含色温数值（K）与光源方向
5. 描述要具体、可用于后续画面生成

输出格式：JSON 对象，包含 characters 数组和 scenes 数组。`;

/**
 * 把 PiNovelStudio 推送的结构化上下文格式化为 prompt 文本块。
 */
function buildContextBlock(
  ctx: VideoProject['novelSource']['novelContext'],
): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.characters && ctx.characters.length > 0) {
    const lines = ctx.characters
      .map(
        (c) =>
          `- ${c.name}（${c.roleType || '角色'}）${c.identity ? `：${c.identity}` : ''}${c.personality ? `；性格：${c.personality}` : ''}`,
      )
      .join('\n');
    parts.push(
      `【原作人物卡（外貌/服装描述需基于这些设定具体化，不要凭空想象）】\n${lines}`,
    );
  }
  if (ctx.outline && ctx.outline.length > 0) {
    const lines = ctx.outline
      .map((n) => `- ${n.title}${n.summary ? `：${n.summary}` : ''}`)
      .join('\n');
    parts.push(`【原作大纲】\n${lines}`);
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n\n` : '';
}

/**
 * 资产提取：从章节文本提取角色圣经卡与场景圣经卡，写入 video_assets。
 * 项目状态：planning → asset_extracting → planning（完成后回到可审阅状态）。
 */
export async function extractAssets(
  db: DatabaseSync,
  projectId: string,
): Promise<void> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const rawText = project.novelSource.rawText;
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('项目没有小说文本（novelSource.rawText 为空）');
  }

  // 状态流转：planning → asset_extracting
  transitionProjectStatus(db, projectId, 'asset_extracting');

  try {
    const contextBlock = buildContextBlock(project.novelSource.novelContext);
    const result = await callLLMAsJSON<LLMAssetResult>({
      system: SYSTEM_PROMPT,
      user: `${contextBlock}请从以下小说文本中提取角色圣经卡和场景圣经卡：\n\n${rawText}`,
      temperature: 0.3,
    });

    // 清除旧资产（重新提取时覆盖；剧集级共享资产保留）
    const existing = listAssetsByProject(db, projectId);
    for (const asset of existing) {
      if (asset.scope === 'series') continue; // 剧集级资产不随集级重提取删除
      deleteAsset(db, asset.id);
    }

    // 写入角色圣经卡
    if (Array.isArray(result.characters)) {
      for (const ch of result.characters) {
        if (!ch.name) continue;
        const description = [
          ch.appearance ? `五官：${ch.appearance}` : '',
          ch.hair ? `发型发色：${ch.hair}` : '',
          ch.eyes ? `瞳色眼神：${ch.eyes}` : '',
          ch.build ? `体态：${ch.build}` : '',
          ch.clothing ? `服装：${ch.clothing}` : '',
          ch.accessories ? `配饰：${ch.accessories}` : '',
          ch.temperament ? `气质：${ch.temperament}` : '',
        ]
          .filter(Boolean)
          .join('；');
        createAsset(db, {
          projectId,
          kind: 'character' as AssetKind,
          name: ch.name,
          description,
          scope: 'project',
        });
      }
    }

    // 写入场景圣经卡（含灯光/声音规格）
    if (Array.isArray(result.scenes)) {
      for (const sc of result.scenes) {
        if (!sc.name) continue;
        const description = [sc.location || '', sc.props || '']
          .filter(Boolean)
          .join('；');
        createAsset(db, {
          projectId,
          kind: 'scene' as AssetKind,
          name: sc.name,
          description,
          lightingSpec: sc.lightingSpec || '',
          audioSpec: sc.audioSpec || '',
          scope: 'project',
        });
      }
    }

    // 状态回流：asset_extracting → planning
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
