/**
 * PiNovelStudio 对接适配器。
 * - 从 PiNovelStudio API 拉取项目与章节（替换粘贴模式）
 * - 鉴权打通（JWT 代理登录 / token 透传）
 * - budget ledger 对接
 *
 * 配置走环境变量：
 *   NOVEL_STUDIO_BASE_URL  — PiNovelStudio API base URL（含 /api 前缀）
 *   NOVEL_STUDIO_TOKEN     — 鉴权 token（或从请求头透传）
 *
 * PiNovelStudio 实际路由（NestJS，全局前缀 /api，JWT Bearer 鉴权）：
 *   POST /api/auth/login                 — 登录，返回 { accessToken, user }
 *   GET  /api/projects?page=&pageSize=  — 项目列表（分页 { items, total, page, pageSize }）
 *   GET  /api/projects/:id/chapters     — 章节列表（数组，含正文 content）
 *   GET  /api/projects/:id/chapters/:cid — 章节详情
 */

export interface NovelProject {
  id: number;
  title: string;
  chapterCount?: number;
  updatedAt?: string;
}

export interface NovelChapter {
  id: number;
  projectId: number;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount: number;
  status: string;
  version: number;
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

/** 代理登录 PiNovelStudio，返回 accessToken。 */
export async function loginNovelStudio(
  email: string,
  password: string,
): Promise<{ accessToken: string; user?: unknown }> {
  const url = `${getBaseUrl()}/auth/login`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`PiNovelStudio 登录失败: HTTP ${resp.status} ${errText.slice(0, 200)}`);
  }
  return (await resp.json()) as { accessToken: string; user?: unknown };
}

/** 拉取 PiNovelStudio 项目列表（分页）。 */
export async function listNovelProjects(
  page = 1,
  pageSize = 50,
  token?: string,
): Promise<{ items: NovelProject[]; total: number; page: number; pageSize: number }> {
  const url = `${getBaseUrl()}/projects?page=${page}&pageSize=${pageSize}`;
  const resp = await fetch(url, { headers: getAuthHeaders(token) });
  if (!resp.ok) {
    throw new Error(`拉取小说项目失败: HTTP ${resp.status}`);
  }
  return (await resp.json()) as {
    items: NovelProject[];
    total: number;
    page: number;
    pageSize: number;
  };
}

/**
 * 从 PiNovelStudio 拉取章节列表（含正文 content）。
 */
export async function fetchChapters(
  novelProjectId: number | string,
  token?: string,
): Promise<NovelChapter[]> {
  const url = `${getBaseUrl()}/projects/${novelProjectId}/chapters`;
  const resp = await fetch(url, {
    headers: getAuthHeaders(token),
  });
  if (!resp.ok) {
    throw new Error(`拉取章节失败: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as NovelChapter[] | { chapters?: NovelChapter[] };
  return Array.isArray(data) ? data : (data.chapters ?? []);
}

/**
 * 从 PiNovelStudio 拉取单个章节内容。
 */
export async function fetchChapter(
  novelProjectId: number | string,
  chapterId: number | string,
  token?: string,
): Promise<NovelChapter> {
  const url = `${getBaseUrl()}/projects/${novelProjectId}/chapters/${chapterId}`;
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
  const url = `${getBaseUrl()}/novels/${novelProjectId}/budget`;
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
