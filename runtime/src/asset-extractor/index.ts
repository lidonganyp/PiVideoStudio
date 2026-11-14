import type { DatabaseSync } from 'node:sqlite';
import { callLLMAsJSON } from '../llm/gateway';
import {
  getProject,
  listSegmentsByProject,
  transitionProjectStatus,
  createAsset,
  listAssetsByProject,
  deleteAsset,
} from '../store';
import type { AssetKind } from '../types';

interface LLMCharacterCard {
  name: string;
  appearance: string;
  clothing: string;
  temperament: string;
}

interface LLMSceneCard {
  name: string;
  location: string;
  lighting: string;
  props: string;
}

interface LLMAssetResult {
  characters: LLMCharacterCard[];
  scenes: LLMSceneCard[];
}

const SYSTEM_PROMPT = `你是一个专业的小说资产提取器。你的任务是从小说章节文本中提取角色卡和场景卡。

角色卡字段：
- name: 角色名
- appearance: 外貌描述（发型、五官、体型等）
- clothing: 服装描述
- temperament: 气质描述

场景卡字段：
- name: 场景名
- location: 地点描述
- lighting: 光线描述
- props: 道具描述

规则：
1. 只提取有名字的角色，群众不提取
2. 场景按地点切换提取，不重复
3. 描述要具体、可用于后续画面生成

输出格式：JSON 对象，包含 characters 数组和 scenes 数组。`;

/**
 * 资产提取：从章节文本提取角色卡与场景卡，写入 video_assets。
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
    const result = await callLLMAsJSON<LLMAssetResult>({
      system: SYSTEM_PROMPT,
      user: `请从以下小说文本中提取角色卡和场景卡：\n\n${rawText}`,
      temperature: 0.3,
    });

    // 清除旧资产（重新提取时覆盖）
    const existing = listAssetsByProject(db, projectId);
    for (const asset of existing) {
      deleteAsset(db, asset.id);
    }

    // 写入角色卡
    if (Array.isArray(result.characters)) {
      for (const ch of result.characters) {
        if (!ch.name) continue;
        const description = [
          ch.appearance || '',
          ch.clothing || '',
          ch.temperament || '',
        ].filter(Boolean).join('；');
        createAsset(db, {
          projectId,
          kind: 'character' as AssetKind,
          name: ch.name,
          description,
        });
      }
    }

    // 写入场景卡
    if (Array.isArray(result.scenes)) {
      for (const sc of result.scenes) {
        if (!sc.name) continue;
        const description = [
          sc.location || '',
          sc.lighting || '',
          sc.props || '',
        ].filter(Boolean).join('；');
        createAsset(db, {
          projectId,
          kind: 'scene' as AssetKind,
          name: sc.name,
          description,
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
