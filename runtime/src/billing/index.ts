import type { DatabaseSync } from 'node:sqlite';
import { listJobsByProject } from '../store';

/** 计费单元类型 */
export type BillingUnit = 'seconds' | 'calls' | 'tokens';

/** 单条计费记录 */
export interface BillingRecord {
  jobId: string;
  segmentId?: string;
  provider: string;
  kind: string;
  unit: BillingUnit;
  amount: number;
  cost: number;
}

/** 项目级成本汇总 */
export interface ProjectCostSummary {
  projectId: string;
  totalCost: number;
  records: BillingRecord[];
  byProvider: Map<string, number>;
  byKind: Map<string, number>;
}

/** Provider 计费费率表（可配置化，后续从环境变量或数据库加载） */
const PROVIDER_RATES: Record<string, Record<string, { unit: BillingUnit; rate: number }>> = {
  mock: {
    t2v: { unit: 'calls', rate: 0 },
    t2i: { unit: 'calls', rate: 0 },
    i2v: { unit: 'calls', rate: 0 },
    tts: { unit: 'calls', rate: 0 },
    compose: { unit: 'calls', rate: 0 },
  },
  keling: {
    t2v: { unit: 'seconds', rate: 0.5 },
    i2v: { unit: 'seconds', rate: 0.6 },
    t2i: { unit: 'calls', rate: 0.2 },
  },
  jimeng: {
    t2v: { unit: 'seconds', rate: 0.4 },
    i2v: { unit: 'seconds', rate: 0.5 },
    t2i: { unit: 'calls', rate: 0.15 },
  },
};

/**
 * 根据任务计算计费记录。
 */
function calculateBilling(job: {
  id: string;
  segmentId?: string;
  provider: string;
  kind: string;
  status: string;
  resultPath?: string;
}): BillingRecord | null {
  if (job.status !== 'succeeded') return null;

  const providerRates = PROVIDER_RATES[job.provider];
  if (!providerRates) return null;

  const rateInfo = providerRates[job.kind];
  if (!rateInfo) return null;

  let amount = 1;
  if (rateInfo.unit === 'seconds') {
    // 从 resultPath 推断时长（简化：默认 5 秒）
    amount = 5;
  } else if (rateInfo.unit === 'calls') {
    amount = 1;
  }

  return {
    jobId: job.id,
    segmentId: job.segmentId,
    provider: job.provider,
    kind: job.kind,
    unit: rateInfo.unit,
    amount,
    cost: amount * rateInfo.rate,
  };
}

/**
 * 计算项目级成本汇总。
 */
export function getProjectCostSummary(
  db: DatabaseSync,
  projectId: string,
): ProjectCostSummary {
  const jobs = listJobsByProject(db, projectId);
  const records: BillingRecord[] = [];
  const byProvider = new Map<string, number>();
  const byKind = new Map<string, number>();
  let totalCost = 0;

  for (const job of jobs) {
    const record = calculateBilling(job);
    if (!record) continue;
    records.push(record);
    totalCost += record.cost;
    byProvider.set(
      record.provider,
      (byProvider.get(record.provider) ?? 0) + record.cost,
    );
    byKind.set(
      record.kind,
      (byKind.get(record.kind) ?? 0) + record.cost,
    );
  }

  return { projectId, totalCost, records, byProvider, byKind };
}

/**
 * 预留接口：对接 PiNovelStudio budget ledger。
 * 融合期将成本数据同步到主项目的预算账本。
 */
export interface BudgetLedgerEntry {
  projectId: string;
  totalCost: number;
  records: BillingRecord[];
  syncedAt: string;
}

export function createBudgetLedgerEntry(
  db: DatabaseSync,
  projectId: string,
): BudgetLedgerEntry {
  const summary = getProjectCostSummary(db, projectId);
  return {
    projectId,
    totalCost: summary.totalCost,
    records: summary.records,
    syncedAt: new Date().toISOString(),
  };
}
