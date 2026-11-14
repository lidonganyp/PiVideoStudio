import express from 'express';
import {
  openDb,
  migrate,
  createProject,
  getProject,
  listProjects,
  listSegmentsByProject,
  splitText,
  buildPrompts,
  type CreateProjectInput,
} from '@pivideo/runtime';
import type { AspectRatio, StyleTemplate } from '@pivideo/runtime';

const app = express();
app.use(express.json());

// 持久化层：SQLite（node:sqlite），启动时自动建表
const db = openDb();
migrate(db);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pivideo-api' });
});

app.get('/api/projects', (_req, res) => {
  res.json(listProjects(db));
});

app.post('/api/projects', (req, res) => {
  const { title, style, aspectRatio, chapterIds, rawText } = req.body ?? {};
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const input: CreateProjectInput = {
    title,
    novelSource: { chapterIds: chapterIds ?? [], rawText },
    style: (style ?? 'narration') as StyleTemplate,
    aspectRatio: (aspectRatio ?? '9:16') as AspectRatio,
  };
  const project = createProject(db, input);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProject(db, req.params.id);
  if (!project) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(project);
});

app.get('/api/projects/:id/segments', (req, res) => {
  const project = getProject(db, req.params.id);
  if (!project) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(listSegmentsByProject(db, req.params.id));
});

app.post('/api/projects/:id/split', async (req, res) => {
  try {
    await splitText(db, req.params.id);
    const segments = listSegmentsByProject(db, req.params.id);
    res.json({ ok: true, segments });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/projects/:id/build-prompts', async (req, res) => {
  try {
    await buildPrompts(db, req.params.id);
    const segments = listSegmentsByProject(db, req.params.id);
    res.json({ ok: true, segments });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT ?? 3100);
app.listen(port, () => {
  console.log('[pivideo-api] listening on http://localhost:' + port);
});
