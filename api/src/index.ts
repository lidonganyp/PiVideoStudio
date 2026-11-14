import './env';
import express from 'express';
import { resolve, join, normalize, sep } from 'node:path';
import { existsSync, createReadStream, statSync } from 'node:fs';
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
  extractAssets,
  listAssetsByProject,
  getAsset,
  updateAsset,
  getImageProvider,
  insertSegmentVersion,
  listSegmentVersions,
  updateSegment,
  generateTTS,
  getProjectCostSummary,
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
  // 检查成片是否存在
  const finalPath = resolve('storage', 'output', project.id, 'final.mp4');
  const finalVideoUrl = existsSync(finalPath)
    ? `/files/output/${project.id}/final.mp4`
    : undefined;
  res.json({ ...project, finalVideoUrl });
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

app.post('/api/projects/:id/extract-assets', async (req, res) => {
  try {
    await extractAssets(db, req.params.id);
    const assets = listAssetsByProject(db, req.params.id);
    res.json({ ok: true, assets });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get('/api/projects/:id/assets', (req, res) => {
  const project = getProject(db, req.params.id);
  if (!project) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(listAssetsByProject(db, req.params.id));
});

app.post('/api/assets/:id/generate-images', async (req, res) => {
  try {
    const asset = getAsset(db, req.params.id);
    if (!asset) {
      res.status(404).json({ error: 'asset not found' });
      return;
    }
    const provider = getImageProvider();
    const submitResult = await provider.submit({
      assetId: asset.id,
      prompt: asset.description,
      aspectRatio: '9:16',
    });
    res.json({ ok: true, providerJobId: submitResult.providerJobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.put('/api/assets/:id/select-image', (req, res) => {
  try {
    const asset = getAsset(db, req.params.id);
    if (!asset) {
      res.status(404).json({ error: 'asset not found' });
      return;
    }
    const { imagePath } = req.body ?? {};
    if (!imagePath) {
      res.status(400).json({ error: 'imagePath is required' });
      return;
    }
    const updated = updateAsset(db, asset.id, { referenceImagePath: imagePath });
    res.json({ ok: true, asset: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/segments/:id/approve', (req, res) => {
  try {
    const seg = getSegment(db, req.params.id);
    if (!seg) {
      res.status(404).json({ error: 'segment not found' });
      return;
    }
    transitionSegmentStatus(db, seg.id, 'approved');
    res.json({ ok: true, segment: getSegment(db, seg.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/segments/:id/reject', (req, res) => {
  try {
    const seg = getSegment(db, req.params.id);
    if (!seg) {
      res.status(404).json({ error: 'segment not found' });
      return;
    }
    transitionSegmentStatus(db, seg.id, 'rejected');
    res.json({ ok: true, segment: getSegment(db, seg.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/segments/:id/regenerate', async (req, res) => {
  try {
    const seg = getSegment(db, req.params.id);
    if (!seg) {
      res.status(404).json({ error: 'segment not found' });
      return;
    }
    insertSegmentVersion(db, {
      segmentId: seg.id,
      version: seg.currentVersion,
      prompt: seg.prompt,
    });
    const { prompt } = req.body ?? {};
    if (prompt) {
      updateSegment(db, seg.id, { prompt });
    }
    db.prepare('UPDATE video_segments SET current_version = current_version + 1 WHERE id = ?').run(seg.id);
    transitionSegmentStatus(db, seg.id, 'rejected');
    transitionSegmentStatus(db, seg.id, 'queued');
    const project = getProject(db, seg.projectId);
    if (project) {
      const provider = getVideoProvider();
      const job = createJob(db, {
        projectId: seg.projectId,
        segmentId: seg.id,
        kind: 't2v',
        provider: provider.name,
      });
      const submitResult = await provider.submit({
        segmentId: seg.id,
        prompt: prompt?.visual ?? seg.prompt?.visual ?? '',
        negative: prompt?.negative ?? seg.prompt?.negative,
        aspectRatio: project.aspectRatio,
        estimatedSeconds: seg.estimatedSeconds,
      });
      updateJob(db, job.id, {
        providerJobId: submitResult.providerJobId,
        status: 'running',
      });
      transitionSegmentStatus(db, seg.id, 'submitted');
    }
    res.json({ ok: true, segment: getSegment(db, seg.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get('/api/segments/:id/versions', (req, res) => {
  const seg = getSegment(db, req.params.id);
  if (!seg) {
    res.status(404).json({ error: 'segment not found' });
    return;
  }
  res.json(listSegmentVersions(db, seg.id));
});

app.post('/api/projects/:id/generate-tts', async (req, res) => {
  try {
    await generateTTS(db, req.params.id);
    res.json({ ok: true });
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

app.get('/api/projects/:id/cost', (req, res) => {
  const project = getProject(db, req.params.id);
  if (!project) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const summary = getProjectCostSummary(db, req.params.id);
  res.json({
    projectId: summary.projectId,
    totalCost: summary.totalCost,
    records: summary.records,
    byProvider: Object.fromEntries(summary.byProvider),
    byKind: Object.fromEntries(summary.byKind),
  });
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
    const allApproved = segments.length > 0 && segments.every((s) => s.status === 'approved');
    if (!allApproved) {
      res.status(400).json({ error: '存在未审核通过的分镜，无法合成' });
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

// 静态文件服务：映射 storage 目录，带路径穿越防护
const STORAGE_DIR = resolve('storage');
app.get('/files/*', (req, res) => {
  const reqPath = req.path.replace(/^\/files\//, '');
  const filePath = normalize(join(STORAGE_DIR, reqPath));
  // 防止路径穿越：确保解析后的路径在 storage 目录内
  if (!filePath.startsWith(STORAGE_DIR + sep) && filePath !== STORAGE_DIR) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    res.status(500).json({ error: 'read error' });
  });
  stream.pipe(res);
});

app.listen(port, () => {
  console.log('[pivideo-api] listening on http://localhost:' + port);
});
