const BASE = '/video';

/** B7 融合：与 PiNovelStudio 同域共享登录态（localStorage['platform_token']）。 */
function getAuthToken(): string | null {
  try {
    return localStorage.getItem('platform_token');
  } catch {
    return null;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const resp = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface StoryProfile {
  genre: string;
  narrativeTone: string;
  mainPlot: string;
  characters: Array<{
    name: string;
    role: string;
    relations: string;
    visualAnchor: string;
  }>;
  worldSetting: string;
  visualStyleHint: string;
}

export interface CostEstimate {
  provider: string;
  segmentCount: number;
  totalSeconds: number;
  videoCost: number;
  imageCost: number;
  ttsCost: number;
  totalCost: number;
  rateDetail: { unit: string; rate: number };
}

export interface Project {
  id: string;
  title: string;
  novelSource: {
    chapterIds: string[];
    rawText?: string;
    storyProfile?: StoryProfile;
  };
  style: string;
  aspectRatio: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finalVideoUrl?: string;
}

export interface Segment {
  id: string;
  projectId: string;
  order: number;
  sourceText: string;
  sceneSummary: string;
  characterNames: string[];
  emotion: string;
  estimatedSeconds: number;
  event: string;
  characterState: string;
  nextSceneHint: string;
  status: string;
  currentVersion: number;
  prompt?: {
    camera: string;
    visual: string;
    negative?: string;
    narration: string;
    subtitle: string;
  };
  shots?: unknown;
  promptV2?: string;
  shotClass?: string;
}

export interface Asset {
  id: string;
  projectId: string;
  kind: 'character' | 'scene';
  name: string;
  description: string;
  referenceImagePath?: string;
  candidateImages: string[];
}

export interface Job {
  id: string;
  projectId: string;
  segmentId?: string;
  kind: string;
  provider: string;
  providerJobId?: string;
  status: string;
  retryCount: number;
  priority?: number;
  providerModel?: string;
  qcResult?: 'approved' | 'suspect' | 'rejected';
  resultPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Series {
  id: string;
  title: string;
  novelProjectId?: string;
  episodeCount: number;
  storyBible?: string;
  createdAt: string;
}
export interface ModelRoute {
  provider: string;
  model: string;
}
export interface ModelRouteTable {
  tier: string;
  routes: Record<string, ModelRoute>;
  route?: ModelRoute;
}
export interface ScreenplayScene {
  sceneNo: number;
  location: string;
  timeOfDay: string;
  lighting: string;
  characters: string[];
  emotion: string;
  content: string;
  sourceText: string;
}
export interface Screenplay {
  scenes: ScreenplayScene[];
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (data: {
    title: string;
    style?: string;
    aspectRatio?: string;
    rawText?: string;
    chapterIds?: string[];
  }) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getSegments: (id: string) =>
    request<Segment[]>(`/api/projects/${id}/segments`),
  splitText: (id: string) =>
    request<{ ok: boolean; segments: Segment[] }>(
      `/api/projects/${id}/split`,
      { method: 'POST' },
    ),
  buildPrompts: (id: string) =>
    request<{ ok: boolean; segments: Segment[] }>(
      `/api/projects/${id}/build-prompts`,
      { method: 'POST' },
    ),
  generateSegments: (id: string) =>
    request<{ ok: boolean; jobs: Job[] }>(
      `/api/projects/${id}/generate-segments`,
      { method: 'POST' },
    ),
  getJobs: (id: string) => request<Job[]>(`/api/projects/${id}/jobs`),
  compose: (id: string) =>
    request<{ ok: boolean; job: Job }>(`/api/projects/${id}/compose`, {
      method: 'POST',
    }),
  analyzeStory: (id: string) =>
    request<{ ok: boolean; storyProfile: StoryProfile }>(
      `/api/projects/${id}/analyze-story`,
      { method: 'POST' },
    ),
  estimate: (id: string) =>
    request<{ ok: boolean; estimate: CostEstimate }>(
      `/api/projects/${id}/estimate`,
      { method: 'POST' },
    ),
  extractAssets: (id: string) =>
    request<{ ok: boolean; assets: Asset[] }>(
      `/api/projects/${id}/extract-assets`,
      { method: 'POST' },
    ),
  getAssets: (id: string) => request<Asset[]>(`/api/projects/${id}/assets`),
  generateImages: (assetId: string) =>
    request<{ ok: boolean; assets: Asset[] }>(
      `/api/assets/${assetId}/generate-images`,
      { method: 'POST' },
    ),
  selectImage: (assetId: string, imagePath: string) =>
    request<{ ok: boolean; asset: Asset }>(
      `/api/assets/${assetId}/select-image`,
      { method: 'PUT', body: JSON.stringify({ imagePath }) },
    ),
  generateSample: (id: string) =>
    request<{ ok: boolean; job: Job; segmentId: string }>(
      `/api/projects/${id}/generate-sample`,
      { method: 'POST' },
    ),
  approveSegment: (segmentId: string) =>
    request<{ ok: boolean; segment: Segment }>(
      `/api/segments/${segmentId}/approve`,
      { method: 'POST' },
    ),
  exportSegmentsUrl: (id: string) => `/api/projects/${id}/export`,
  // ---- v1.1 新增 ----
  listSeries: () => request<Series[]>('/api/series'),
  createSeries: (data: { title: string; novelProjectId?: string; episodeCount?: number; storyBible?: string }) =>
    request<{ ok: boolean; series: Series }>('/api/series', { method: 'POST', body: JSON.stringify(data) }),
  getSeries: (id: string) => request<Series>(`/api/series/${id}`),
  updateSeries: (id: string, data: { title?: string; episodeCount?: number; storyBible?: string }) =>
    request<{ ok: boolean; series: Series }>(`/api/series/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  getModelRoutes: (shotClass?: string) =>
    request<ModelRouteTable>(`/api/model-routes${shotClass ? '?shotClass=' + shotClass : ''}`),
  adaptScreenplay: (projectId: string) =>
    request<{ ok: boolean; screenplay: Screenplay }>(`/api/projects/${projectId}/adapt-screenplay`, { method: 'POST' }),
  regenerateSegment: (segmentId: string, options?: { prompt?: unknown; draft?: boolean }) =>
    request<{ ok: boolean; segment: Segment }>(`/api/segments/${segmentId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  generateSegmentsDraft: (projectId: string) =>
    request<{ ok: boolean; jobs: Job[]; errors?: unknown[] }>(`/api/projects/${projectId}/generate-segments`, {
      method: 'POST',
      body: JSON.stringify({ draft: true }),
    }),
};

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

/** PiNovelStudio 章节来源（经 PiVideoStudio API 代理） */
export const pinovelApi = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user?: unknown }>('/api/pinovel/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  listProjects: (token: string, page = 1, pageSize = 50) =>
    request<{ items: NovelProject[]; total: number; page: number; pageSize: number }>(
      `/api/pinovel/projects?page=${page}&pageSize=${pageSize}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  listChapters: (token: string, projectId: number | string) =>
    request<NovelChapter[]>(`/api/pinovel/projects/${projectId}/chapters`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
};