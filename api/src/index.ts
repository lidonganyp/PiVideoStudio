import './env';
import express from 'express';
import { resolve, join, normalize, sep } from 'node:path';
import {
  existsSync,
  createReadStream,
  statSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  getJob,
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
  analyzeStory,
  estimateProjectCost,
  getVideoProviderName,
  loginNovelStudio,
  listNovelProjects,
  fetchChapters,
  STORAGE_DIR,
  type CreateProjectInput,
} from '@pivideo/runtime';
import type { AspectRatio, StyleTemplate, VideoJob } from '@pivideo/runtime';

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
  const { title, style, aspectRatio, chapterIds, rawText, novelContext } = req.body ?? {};
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const input: CreateProjectInput = {
    title,
    novelSource: {
      chapterIds: chapterIds ?? [],
      rawText,
      ...(novelContext ? { novelContext } : {}),
    },
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
  const finalPath = resolve(STORAGE_DIR, 'output', project.id, 'final.mp4');
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

app.post('/api/projects/:id/analyze-story', async (req, res) => {
  try {
    const profile = await analyzeStory(db, req.params.id);
    res.json({ ok: true, storyProfile: profile });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/projects/:id/estimate', (req, res) => {
  try {
    const segments = listSegmentsByProject(db, req.params.id);
    if (segments.length === 0) {
      res.status(400).json({ error: '项目还没有分镜，请先完成场景切片' });
      return;
    }
    const providerName = getVideoProviderName();
    const estimate = estimateProjectCost(providerName, segments);
    res.json({ ok: true, estimate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
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
    // 在线轮询等待候选图就绪（最多 30s，mock 模式约 2s）
    const deadline = Date.now() + 30_000;
    let images: string[] = [];
    let lastError = '';
    while (Date.now() < deadline) {
      const query = await provider.query(submitResult.providerJobId);
      if (query.status === 'succeeded' && query.images) {
        images = query.images.map((img) => img.imageUrl);
        break;
      }
      if (query.status === 'failed') {
        lastError = query.error ?? 'image generation failed';
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (images.length === 0) {
      res.status(500).json({
        error: lastError || '候选图生成超时（30s），请重试',
      });
      return;
    }
    // 候选图写入资产（select-image 确认后清空）
    updateAsset(db, asset.id, { candidateImages: images });
    const assets = listAssetsByProject(db, asset.projectId);
    res.json({ ok: true, assets });
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
    // 确认选定图，同时清空候选列表
    const updated = updateAsset(db, asset.id, {
      referenceImagePath: imagePath,
      candidateImages: [],
    });
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

app.post('/api/projects/:id/generate-sample', async (req, res) => {
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
      res.status(400).json({ error: '没有 prompt_ready 状态的分镜，请先生成提示词' });
      return;
    }
    // 只取第一个待生成分镜作为样片
    const sample = ready[0];
    const provider = getVideoProvider();
    transitionProjectStatus(db, projectId, 'segment_generating');
    transitionSegmentStatus(db, sample.id, 'queued');
    const job = createJob(db, {
      projectId,
      segmentId: sample.id,
      kind: 't2v',
      provider: provider.name,
    });
    try {
      const submitResult = await provider.submit({
        segmentId: sample.id,
        prompt: sample.prompt?.visual ?? '',
        negative: sample.prompt?.negative,
        aspectRatio: project.aspectRatio,
        estimatedSeconds: sample.estimatedSeconds,
      });
      updateJob(db, job.id, {
        providerJobId: submitResult.providerJobId,
        status: 'running',
      });
      transitionSegmentStatus(db, sample.id, 'submitted');
    } catch (err) {
      // 提交失败（如 429 限流）：回滚 job/segment 状态，避免卡死（failed 可经 regenerate 恢复）
      const message = err instanceof Error ? err.message : String(err);
      updateJob(db, job.id, { status: 'failed', error: message });
      transitionSegmentStatus(db, sample.id, 'failed');
      res.status(502).json({ error: `样片提交失败: ${message}` });
      return;
    }
    res.json({ ok: true, job, segmentId: sample.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/projects/:id/export', async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = getProject(db, projectId);
    if (!project) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const segments = listSegmentsByProject(db, projectId);
    const jobs = listJobsByProject(db, projectId).filter(
      (j) => j.kind === 't2v' && j.status === 'succeeded' && j.resultPath,
    );
    if (jobs.length === 0) {
      res.status(400).json({ error: '没有已生成的视频片段可导出' });
      return;
    }
    // 准备打包目录：按分镜顺序命名
    const exportDir = mkdtempSync(join(tmpdir(), `pivideo-export-${projectId}-`));
    let copied = 0;
    for (const job of jobs) {
      if (!job.resultPath || !existsSync(job.resultPath)) continue;
      const seg = segments.find((s) => s.id === job.segmentId);
      const order = seg ? String(seg.order).padStart(3, '0') : 'unknown';
      const destName = `segment-${order}.mp4`;
      copyFileSync(job.resultPath, join(exportDir, destName));
      copied += 1;
    }
    if (copied === 0) {
      rmSync(exportDir, { recursive: true, force: true });
      res.status(400).json({ error: '片段文件不存在，可能已被清理' });
      return;
    }
    // 生成 ffmpeg 合成脚本（本地执行参考）
    const listFile = join(exportDir, 'concat-list.txt');
    const sorted = readdirSync(exportDir)
      .filter((f) => f.endsWith('.mp4'))
      .sort();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      listFile,
      sorted.map((f) => `file '${f}'`).join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(exportDir, 'compose.sh'),
      `#!/usr/bin/env bash\n# 本地合成脚本：把全部片段拼接为成片（需本机安装 ffmpeg）\ncd "$(dirname \"$0\")"\nffmpeg -y -f concat -safe 0 -i concat-list.txt -c copy final.mp4\necho \"成片已生成: $(pwd)/final.mp4\"\n`,
      'utf-8',
    );
    // 打包 zip
    const zipName = `pivideo-${project.title.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}-segments.zip`;
    const zipPath = join(tmpdir(), zipName);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        'zip',
        ['-r', zipPath, '.'],
        { cwd: exportDir },
        (err) => {
          if (err) rejectPromise(new Error(`zip 打包失败: ${err.message}`));
          else resolvePromise();
        },
      );
    });
    rmSync(exportDir, { recursive: true, force: true });
    // 发送 zip 文件
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    );
    const stream = createReadStream(zipPath);
    stream.on('end', () => rmSync(zipPath, { force: true }));
    stream.on('error', () => {
      rmSync(zipPath, { force: true });
      if (!res.headersSent) res.status(500).json({ error: 'read error' });
    });
    stream.pipe(res);
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
    // prompt_ready + failed（如 429 限流失败，已有 prompt 可直接重提；failed→queued 为合法转换）
    const ready = segments.filter(
      (s) => s.status === 'prompt_ready' || (s.status === 'failed' && s.prompt),
    );
    if (ready.length === 0) {
      res.status(400).json({ error: '没有 prompt_ready 状态的分镜可生成' });
      return;
    }
    const provider = getVideoProvider();
    const concurrency = Number(process.env.GENERATE_CONCURRENCY ?? 3);
    transitionProjectStatus(db, projectId, 'segment_generating');
    const jobs: VideoJob[] = [];
    const errors: Array<{ segmentId: string; error: string }> = [];
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
          try {
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
          } catch (err) {
            // 提交失败（如 429 限流）：回滚该 job/segment，不中断整批（failed 可经 regenerate 恢复）
            const message = err instanceof Error ? err.message : String(err);
            updateJob(db, job.id, { status: 'failed', error: message });
            transitionSegmentStatus(db, seg.id, 'failed');
            errors.push({ segmentId: seg.id, error: message });
            return null;
          }
        }),
      );
      jobs.push(...results.filter((j): j is VideoJob => j !== null));
    }
    if (jobs.length === 0) {
      res.status(502).json({
        error: `全部分镜提交失败: ${errors[0]?.error ?? 'unknown'}`,
        errors,
      });
      return;
    }
    res.json({ ok: true, jobs, errors });
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

// ---- PiNovelStudio 章节来源代理（B5）----
// 鉴权 token 从请求头 Authorization: Bearer <token> 透传到 PiNovelStudio

app.post('/api/pinovel/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    const result = await loginNovelStudio(String(email), String(password));
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.get('/api/pinovel/projects', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const result = await listNovelProjects(page, pageSize, token);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.get('/api/pinovel/projects/:id/chapters', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const chapters = await fetchChapters(req.params.id, token);
    res.json(chapters);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

const port = Number(process.env.PORT ?? 3100);

// 静态文件服务：映射 storage 目录，带路径穿越防护
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
