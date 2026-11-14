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
  listJobsByProject,
  createJob,
  updateJob,
  getSegment,
  transitionSegmentStatus,
  transitionProjectStatus,
  getVideoProvider,
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

app.post('/api/projects/:id/generate-segments', async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = getProject(db, projectId);
    if (!project) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const segments = listSegmentsByProject(db, projectId);
    const ready = segments.filter((s) => s.status === 'prompt_ready');
    if (ready.length === 0) {
      res.status(400).json({ error: '没有 prompt_ready 状态的分镜可生成' });
      return;
    }
    const provider = getVideoProvider();
    const concurrency = Number(process.env.GENERATE_CONCURRENCY ?? 3);
    transitionProjectStatus(db, projectId, 'segment_generating');
    const jobs = [];
    for (let i = 0; i < ready.length; i += concurrency) {
      const batch = ready.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (seg) => {
          transitionSegmentStatus(db, seg.id, 'queued');
          const job = createJob(db, {
            projectId,
            segmentId: seg.id,
            kind: 't2v',
            provider: provider.name,
          });
          const submitResult = await provider.submit({
            segmentId: seg.id,
            prompt: seg.prompt?.visual ?? '',
            negative: seg.prompt?.negative,
            aspectRatio: project.aspectRatio,
            estimatedSeconds: seg.estimatedSeconds,
          });
          updateJob(db, job.id, {
            providerJobId: submitResult.providerJobId,
            status: 'running',
          });
          transitionSegmentStatus(db, seg.id, 'submitted');
          return job;
        }),
      );
      jobs.push(...results);
    }
    res.json({ ok: true, jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get('/api/projects/:id/jobs', (req, res) => {
  const project = getProject(db, req.params.id);
  if (!project) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(listJobsByProject(db, req.params.id));
});

app.post('/api/projects/:id/compose', (req, res) => {
  try {
    const projectId = req.params.id;
    const project = getProject(db, projectId);
    if (!project) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const segments = listSegmentsByProject(db, projectId);
    const allSucceeded = segments.length > 0 && segments.every((s) => s.status === 'succeeded');
    if (!allSucceeded) {
      res.status(400).json({ error: '存在未成功的分镜，无法合成' });
      return;
    }
    const job = createJob(db, {
      projectId,
      kind: 'compose',
      provider: 'ffmpeg',
    });
    res.json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT ?? 3100);
app.listen(port, () => {
  console.log('[pivideo-api] listening on http://localhost:' + port);
});
