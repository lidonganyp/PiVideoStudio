const BASE = '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface Project {
  id: string;
  title: string;
  novelSource: { chapterIds: string[]; rawText?: string };
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
  status: string;
  currentVersion: number;
  prompt?: {
    camera: string;
    visual: string;
    negative?: string;
    narration: string;
    subtitle: string;
  };
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
  resultPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (data: {
    title: string;
    style?: string;
    aspectRatio?: string;
    rawText?: string;
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
};
