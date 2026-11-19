/**
 * 模型路由器：按镜头类型将生成任务路由到对应模型。
 *
 * 设计理念：把多个模型当成一个『剧组』使用——
 * 对话/表演、VFX 奇观镜头走高能力模型，空镜/转场与草稿迭代走低价模型。
 *
 * 档位切换：环境变量 QUALITY_TIER=test | prod，整组映射一键切换，代码零改动。
 * - test：测试期全部走 MiniMax-H3（30s、并发 4、性价比高）
 * - prod：稳定期对话/表演/VFX 走 Seedance 2.5，空镜走 2.0 Mini，草稿走 2.0 Fast
 */

/** 镜头类型：决定路由到哪个模型 */
export type ShotClass = 'dialogue' | 'performance' | 'vfx' | 'broll' | 'draft';

/** 质量档位：test=测试期，prod=稳定期 */
export type QualityTier = 'test' | 'prod';

/** 路由结果：目标供应商与具体模型 */
export interface ModelRoute {
  provider: string;
  model: string;
}

/** 档位 × 镜头类型的路由映射表 */
const ROUTES: Record<QualityTier, Record<ShotClass, ModelRoute>> = {
  test: {
    dialogue: { provider: 'minimax', model: 'MiniMax-H3' },
    performance: { provider: 'minimax', model: 'MiniMax-H3' },
    vfx: { provider: 'minimax', model: 'MiniMax-H3' },
    broll: { provider: 'minimax', model: 'MiniMax-H3' },
    draft: { provider: 'minimax', model: 'MiniMax-H3' },
  },
  prod: {
    dialogue: { provider: 'seedance', model: 'seedance-2.5' },
    performance: { provider: 'seedance', model: 'seedance-2.5' },
    vfx: { provider: 'seedance', model: 'seedance-2.5' },
    broll: { provider: 'seedance', model: 'seedance-2.0-mini' },
    draft: { provider: 'seedance', model: 'seedance-2.0-fast' },
  },
};

/** 读取当前质量档位 */
export function getQualityTier(): QualityTier {
  const tier = process.env.QUALITY_TIER ?? 'test';
  return tier === 'prod' ? 'prod' : 'test';
}

/**
 * 按镜头类型路由模型。
 * @param shotClass 镜头类型；未标注时默认 dialogue（走高能力模型保证质量）
 */
export function routeShot(shotClass?: ShotClass): ModelRoute {
  const tier = getQualityTier();
  const cls: ShotClass = shotClass ?? 'dialogue';
  return ROUTES[tier][cls];
}

/** 返回当前档位的完整路由表（供管理端展示与调试） */
export function getRouteTable(): Record<ShotClass, ModelRoute> {
  return ROUTES[getQualityTier()];
}
