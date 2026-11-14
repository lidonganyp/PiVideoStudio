import express from 'express';
import { randomUUID } from 'node:crypto';
import type { VideoProject } from '@pivideo/runtime';

const app = express();
app.use(express.json());

// 内存存储：骨架阶段先用内存，后续替换为数据库
const projects = new Map<string, VideoProject>();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pivideo-api' });
});

app.get('/api/projects', (_req, res) => {
  res.json(Array.from(projects.values()));
});

app.post('/api/projects', (req, res) => {
  const { title, style, aspectRatio, chapterIds, rawText } = req.body ?? {};
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const now = new Date().toISOString();
  const project: VideoProject = {
    id: randomUUID(),
    title,
    novelSource: { chapterIds: chapterIds ?? [], rawText },
    style: style ?? 'narration',
    aspectRatio: aspectRatio ?? '9:16',
    status: 'planning',
    createdAt: now,
    updatedAt: now,
  };
  projects.set(project.id, project);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(project);
});

const port = Number(process.env.PORT ?? 3100);
app.listen(port, () => {
  console.log('[pivideo-api] listening on http://localhost:' + port);
});
