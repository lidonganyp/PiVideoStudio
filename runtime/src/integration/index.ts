/**
 * PiNovelStudio 对接适配器。
 * - 从主项目 API 拉取章节文本（替换粘贴模式）
 * - 鉴权打通（token 透传）
 * - budget ledger 对接
 *
 * 配置走环境变量：
 *   NOVEL_STUDIO_BASE_URL  — 主项目 API base URL
 *   NOVEL_STUDIO_TOKEN     — 鉴权 token（或从请求头透传）
 */

export interface NovelChapter {
  id: string;
  title: string;
  content: string;
  projectId: string;
}

function getBaseUrl(): string {
  const url = process.env.NOVEL_STUDIO_BASE_URL;
  if (!url) {
    throw new Error('未配置 NOVEL_STUDIO_BASE_URL');
  }
  return url;
}

function getAuthHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const authToken = token ?? process.env.NOVEL_STUDIO_TOKEN;
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return headers;
}

/**
 * 从 PiNovelStudio 拉取章节列表。
 */
export async function fetchChapters(
  novelProjectId: string,
  token?: string,
): Promise<NovelChapter[]> {
  const url = `${getBaseUrl()}/api/novels/${novelProjectId}/chapters`;
  const resp = await fetch(url, {
    headers: getAuthHeaders(token),
  });
  if (!resp.ok) {
    throw new Error(`拉取章节失败: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { chapters?: NovelChapter[] };
  return data.chapters ?? [];
}

/**
 * 从 PiNovelStudio 拉取单个章节内容。
 */
export async function fetchChapter(
  chapterId: string,
  token?: string,
): Promise<NovelChapter> {
  const url = `${getBaseUrl()}/api/chapters/${chapterId}`;
  const resp = await fetch(url, {
    headers: getAuthHeaders(token),
  });
  if (!resp.ok) {
    throw new Error(`拉取章节失败: HTTP ${resp.status}`);
  }
  return (await resp.json()) as NovelChapter;
}

/**
 * 同步成本数据到 PiNovelStudio budget ledger。
 */
export async function syncBudgetLedger(
  novelProjectId: string,
  ledgerEntry: {
    projectId: string;
    totalCost: number;
    records: Array<{ provider: string; kind: string; amount: number; cost: number }>;
  },
  token?: string,
): Promise<void> {
  const url = `${getBaseUrl()}/api/novels/${novelProjectId}/budget`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders(token),
    body: JSON.stringify(ledgerEntry),
  });
  if (!resp.ok) {
    throw new Error(`同步预算账本失败: HTTP ${resp.status}`);
  }
}

/**
 * 创建视频工场入口配置（供主项目 PortalLayout 集成）。
 * 主项目侧在 PortalLayout 中添加『视频工场』入口，
 * 跳转到 PiVideoStudio web 前端并透传 token。
 */
export interface PortalEntryConfig {
  label: string;
  url: string;
  icon?: string;
}

export function getPortalEntryConfig(): PortalEntryConfig {
  const webUrl = process.env.PIVIDEO_WEB_URL ?? 'http://localhost:5173';
  return {
    label: '视频工场',
    url: webUrl,
    icon: 'video',
  };
}
