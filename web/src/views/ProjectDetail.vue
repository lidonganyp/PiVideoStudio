<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  api,
  type Project,
  type Segment,
  type Job,
  type Asset,
  type CostEstimate,
  type StoryProfile,
} from '../api';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const project = ref<Project | null>(null);
const segments = ref<Segment[]>([]);
const jobs = ref<Job[]>([]);
const assets = ref<Asset[]>([]);
const estimate = ref<CostEstimate | null>(null);
/** 正在生成候选图的资产 ID 集合 */
const imageLoading = ref<Set<string>>(new Set());
/** 样片确认状态 */
const sampleSegmentId = ref('');
const sampleReady = ref(false);
const loading = ref(false);
const error = ref('');
const actionLoading = ref('');

let pollTimer: ReturnType<typeof setInterval> | undefined;

async function loadData() {
  loading.value = true;
  try {
    const [p, segs, j, a] = await Promise.all([
      api.getProject(projectId),
      api.getSegments(projectId),
      api.getJobs(projectId),
      api.getAssets(projectId),
    ]);
    project.value = p;
    segments.value = segs;
    jobs.value = j;
    assets.value = a;
    // 样片状态恢复
    if (sampleSegmentId.value) {
      const sample = segs.find((s) => s.id === sampleSegmentId.value);
      sampleReady.value = sample?.status === 'succeeded';
    } else {
      const firstDone = segs.find((s) => s.status === 'succeeded' || s.status === 'approved');
      if (firstDone) sampleSegmentId.value = firstDone.id;
      sampleReady.value = Boolean(firstDone);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 向导步骤推导：根据项目数据自动定位 */
type WizardStep = 'analyze' | 'segments' | 'estimate' | 'dashboard';
const step = computed<WizardStep>(() => {
  const p = project.value;
  if (!p) return 'analyze';
  if (!p.novelSource.storyProfile) return 'analyze';
  if (segments.value.length === 0) return 'segments';
  const started =
    jobs.value.length > 0 ||
    segments.value.some((s) => s.status !== 'draft');
  if (!started) return 'estimate';
  return 'dashboard';
});

const storyProfile = computed<StoryProfile | undefined>(
  () => project.value?.novelSource.storyProfile,
);

const progressStats = computed(() => {
  const total = segments.value.length;
  const succeeded = segments.value.filter(
    (s) => s.status === 'succeeded' || s.status === 'approved',
  ).length;
  const running = segments.value.filter((s) =>
    ['queued', 'submitted', 'polling'].includes(s.status),
  ).length;
  const failed = segments.value.filter((s) => s.status === 'failed').length;
  const percent = total > 0 ? Math.round((succeeded / total) * 100) : 0;
  return { total, succeeded, running, failed, percent };
});

async function doAction(name: string, fn: () => Promise<unknown>) {
  actionLoading.value = name;
  error.value = '';
  try {
    await fn();
    await loadData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoading.value = '';
  }
}

const analyzeStory = () =>
  doAction('analyze', () => api.analyzeStory(projectId));
const adaptScreenplay = () =>
  doAction('adapt', () => api.adaptScreenplay(projectId));
const splitText = () => doAction('split', () => api.splitText(projectId));
const loadEstimate = () =>
  doAction('estimate', async () => {
    const res = await api.estimate(projectId);
    estimate.value = res.estimate;
  });
const buildPrompts = () =>
  doAction('prompts', () => api.buildPrompts(projectId));
const generateSegments = () =>
  doAction('generate', () => api.generateSegments(projectId));
const compose = () => doAction('compose', () => api.compose(projectId));

/** 确认节点 1：提取资产（角色/场景卡） */
const extractAssets = () =>
  doAction('assets', () => api.extractAssets(projectId));

/** 确认节点 2/3：为资产生成候选参考图 */
async function generateImagesFor(assetId: string) {
  imageLoading.value = new Set([...imageLoading.value, assetId]);
  error.value = '';
  try {
    const res = await api.generateImages(assetId);
    assets.value = res.assets;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    const next = new Set(imageLoading.value);
    next.delete(assetId);
    imageLoading.value = next;
  }
}

/** 确认选定参考图 */
async function selectImageFor(assetId: string, imagePath: string) {
  error.value = '';
  try {
    await api.selectImage(assetId, imagePath);
    const a = await api.getAssets(projectId);
    assets.value = a;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** 确认节点 4：生成首个样片 */
async function generateSample() {
  actionLoading.value = 'sample';
  error.value = '';
  try {
    // 仅当没有 prompt_ready 分镜时才构建提示词（重复调用会因无 draft 分镜报错）
    const hasReady = segments.value.some((s) => s.status === 'prompt_ready');
    if (!hasReady) {
      await api.buildPrompts(projectId);
    }
    const res = await api.generateSample(projectId);
    sampleSegmentId.value = res.segmentId;
    sampleReady.value = false;
    await loadData();
    startPolling();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoading.value = '';
  }
}

/** 样片确认后批量生成剩余分镜 */
async function confirmSampleAndGenerateAll() {
  actionLoading.value = 'start';
  error.value = '';
  try {
    await api.generateSegments(projectId);
    await loadData();
    startPolling();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoading.value = '';
  }
}

/** 资产确认进度 */
const assetConfirmStats = computed(() => {
  const list = assets.value;
  const total = list.length;
  const confirmed = list.filter((a) => a.referenceImagePath).length;
  const withCandidates = list.filter(
    (a) => !a.referenceImagePath && a.candidateImages.length > 0,
  ).length;
  return { total, confirmed, withCandidates, allConfirmed: total > 0 && confirmed === total };
});

/** 样片视频 URL */
const sampleVideoUrl = computed(() => {
  if (!sampleSegmentId.value) return '';
  const job = jobs.value.find(
    (j) => j.segmentId === sampleSegmentId.value && j.status === 'succeeded' && j.resultPath,
  );
  return job ? job.resultPath!.replace(/^.*storage\//, '/files/') : '';
});

/** 样片待确认：样片已成功且其余分镜尚未批量提交 */
const samplePendingConfirm = computed(() => {
  if (!sampleSegmentId.value || !sampleReady.value) return false;
  const others = segments.value.filter((s) => s.id !== sampleSegmentId.value);
  return (
    others.length > 0 &&
    others.every((s) => s.status === 'draft' || s.status === 'prompt_ready')
  );
});

/** 导出片段包（POST 下载 zip） */
async function exportSegments() {
  actionLoading.value = 'export';
  error.value = '';
  try {
    const resp = await fetch(api.exportSegmentsUrl(projectId), { method: 'POST' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `segments-${projectId}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoading.value = '';
  }
}

/** 一键开始：提示词 → 视频生成 */
async function startGeneration() {
  actionLoading.value = 'start';
  error.value = '';
  try {
    await api.buildPrompts(projectId);
    await api.generateSegments(projectId);
    await loadData();
    startPolling();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoading.value = '';
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await loadData();
    const { running } = progressStats.value;
    const pendingJobs = jobs.value.some(
      (j) => j.status === 'queued' || j.status === 'running',
    );
    if (running === 0 && !pendingJobs) stopPolling();
  }, 5000);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

onMounted(async () => {
  await loadData();
  if (step.value === 'dashboard') startPolling();
  if (step.value === 'estimate' && !estimate.value) {
    // 自动加载预估（只读接口，无副作用）
    try {
      const res = await api.estimate(projectId);
      estimate.value = res.estimate;
    } catch {
      /* 忽略：用户可手动点击重试 */
    }
  }
});
onUnmounted(stopPolling);
</script>

<template>
  <div class="page">
    <div class="header">
      <button @click="router.push('/')" class="back">← 返回</button>
      <h1>{{ project?.title ?? '加载中...' }}</h1>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- 步骤指示器 -->
    <div class="steps">
      <span :class="['step', { active: step === 'analyze', done: step !== 'analyze' }]">1 文本解析</span>
      <span :class="['step', { active: step === 'segments', done: step === 'estimate' || step === 'dashboard' }]">2 切片确认</span>
      <span :class="['step', { active: step === 'estimate', done: step === 'dashboard' }]">3 预估确认</span>
      <span :class="['step', { active: step === 'dashboard' }]">4 生成进度</span>
    </div>

    <!-- Step 1: 文本解析 -->
    <section v-if="step === 'analyze'" class="card">
      <h2>第 1 步：解析小说文本</h2>
      <p class="hint">系统将分析文本的题材、主线、人物与视觉风格，为全片生成保持一致性。</p>
      <button @click="analyzeStory" :disabled="actionLoading === 'analyze'" class="btn primary">
        {{ actionLoading === 'analyze' ? '解析中...' : '开始解析' }}
      </button>
    </section>

    <!-- Step 1 完成后的档案展示 + Step 2 入口 -->
    <section v-if="storyProfile" class="card">
      <h2>故事档案</h2>
      <div class="profile-grid">
        <div><b>题材</b>{{ storyProfile.genre }}</div>
        <div><b>基调</b>{{ storyProfile.narrativeTone }}</div>
        <div class="span2"><b>主线</b>{{ storyProfile.mainPlot }}</div>
        <div class="span2"><b>世界观</b>{{ storyProfile.worldSetting }}</div>
      </div>
      <div v-if="storyProfile.characters.length > 0" class="characters">
        <h3>人物 ({{ storyProfile.characters.length }})</h3>
        <div v-for="c in storyProfile.characters" :key="c.name" class="char-card">
          <strong>{{ c.name }}</strong>
          <span class="role">{{ c.role }}</span>
          <p class="anchor">{{ c.visualAnchor }}</p>
          <p v-if="c.relations" class="relations">{{ c.relations }}</p>
        </div>
      </div>
    </section>

    <!-- 剧本改编（v1.1） -->
    <section v-if="storyProfile && segments.length === 0" class="card">
      <h2>剧本改编</h2>
      <p class="hint">将小说文本改编为结构化剧本（场景表），为切片和提示词构建提供基础。</p>
      <button @click="adaptScreenplay" :disabled="actionLoading === 'adapt'" class="btn primary">
        {{ actionLoading === 'adapt' ? '改编中...' : '改编剧本' }}
      </button>
    </section>
    <!-- Step 2: 切片确认 -->
    <section v-if="step === 'segments'" class="card">
      <h2>第 2 步：生成场景切片</h2>
      <p class="hint">按场景把小说切分为连续分镜，每个切片包含事件、人物状态与下一场景衔接。</p>
      <button @click="splitText" :disabled="actionLoading === 'split'" class="btn primary">
        {{ actionLoading === 'split' ? '切片中...' : '生成场景切片' }}
      </button>
    </section>

    <!-- 切片列表（segments 步骤 & estimate 步骤可见） -->
    <section v-if="segments.length > 0 && step !== 'dashboard'" class="card">
      <h2>场景切片 ({{ segments.length }})</h2>
      <div v-for="seg in segments" :key="seg.id" class="slice">
        <div class="slice-head">
          <strong>#{{ seg.order }}</strong>
          <span class="emotion">{{ seg.emotion }}</span>
          <span class="duration">{{ seg.estimatedSeconds }}s</span>
        </div>
        <p class="event">{{ seg.event }}</p>
        <p class="slice-text">{{ seg.sourceText }}</p>
        <div class="slice-meta">
          <span v-if="seg.characterState">👤 {{ seg.characterState }}</span>
          <span v-if="seg.nextSceneHint">→ {{ seg.nextSceneHint }}</span>
        </div>
      </div>
    </section>

    <!-- Step 3: 预估确认 -->
    <section v-if="step === 'estimate'" class="card">
      <h2>第 3 步：时长与费用预估</h2>
      <div v-if="estimate" class="estimate">
        <div class="est-row"><span>供应商</span><b>{{ estimate.provider }}</b></div>
        <div class="est-row"><span>分镜数</span><b>{{ estimate.segmentCount }}</b></div>
        <div class="est-row"><span>预估总时长</span><b>{{ estimate.totalSeconds }} 秒</b></div>
        <div class="est-row"><span>视频生成</span><b>¥ {{ estimate.videoCost }}</b></div>
        <div class="est-row"><span>参考图</span><b>¥ {{ estimate.imageCost }}</b></div>
        <div class="est-row"><span>配音</span><b>¥ {{ estimate.ttsCost }}</b></div>
        <div class="est-row total"><span>合计预估</span><b>¥ {{ estimate.totalCost }}</b></div>
        <p class="hint">费率：{{ estimate.rateDetail.rate }} 元/{{ estimate.rateDetail.unit === 'seconds' ? '秒' : '次' }}</p>
      </div>
      <!-- 确认节点 1-3：资产与参考图确认 -->
      <div class="asset-section">
        <h3>角色 / 场景资产确认</h3>
        <p v-if="assets.length === 0" class="hint">
          先提取角色与场景资产卡，为每个资产生成候选参考图并选定一张，保证全片视觉一致性。
        </p>
        <button
          v-if="assets.length === 0"
          @click="extractAssets"
          :disabled="actionLoading === 'assets'"
          class="btn"
        >
          {{ actionLoading === 'assets' ? '提取中...' : '提取角色 / 场景资产' }}
        </button>
        <template v-else>
          <p class="hint">
            参考图确认进度：{{ assetConfirmStats.confirmed }}/{{ assetConfirmStats.total }}
            <span v-if="assetConfirmStats.allConfirmed">· 全部确认 ✓</span>
          </p>
          <div v-for="asset in assets" :key="asset.id" class="asset-card">
            <div class="asset-head">
              <span :class="['asset-kind', asset.kind]">
                {{ asset.kind === 'character' ? '角色' : '场景' }}
              </span>
              <strong>{{ asset.name }}</strong>
              <span v-if="asset.referenceImagePath" class="asset-done">已确认 ✓</span>
            </div>
            <p class="asset-desc">{{ asset.description }}</p>
            <div v-if="asset.referenceImagePath" class="candidate-grid">
              <img
                :src="asset.referenceImagePath.replace(/^.*storage\//, '/files/')"
                :alt="asset.name"
                class="asset-img selected"
              />
            </div>
            <template v-else>
              <button
                v-if="asset.candidateImages.length === 0"
                @click="generateImagesFor(asset.id)"
                :disabled="imageLoading.has(asset.id)"
                class="btn small"
              >
                {{ imageLoading.has(asset.id) ? '生成中...' : '生成候选参考图' }}
              </button>
              <div v-else class="candidate-grid">
                <img
                  v-for="(img, i) in asset.candidateImages"
                  :key="img"
                  :src="img.replace(/^.*storage\//, '/files/')"
                  :alt="`${asset.name} 候选 ${i + 1}`"
                  class="asset-img candidate"
                  @click="selectImageFor(asset.id, img)"
                />
                <button
                  @click="generateImagesFor(asset.id)"
                  :disabled="imageLoading.has(asset.id)"
                  class="btn small"
                >
                  {{ imageLoading.has(asset.id) ? '生成中...' : '重新生成' }}
                </button>
              </div>
            </template>
          </div>
        </template>
      </div>
      <div class="btn-row">
        <button v-if="!estimate" @click="loadEstimate" :disabled="actionLoading === 'estimate'" class="btn">
          {{ actionLoading === 'estimate' ? '计算中...' : '重新计算预估' }}
        </button>
        <button
          @click="generateSample"
          :disabled="actionLoading === 'sample' || !assetConfirmStats.allConfirmed"
          class="btn primary"
        >
          {{ actionLoading === 'sample' ? '样片生成中...' : '生成首个样片（确认效果）' }}
        </button>
        <button
          @click="startGeneration"
          :disabled="actionLoading === 'start' || !assetConfirmStats.allConfirmed"
          class="btn"
        >
          {{ actionLoading === 'start' ? '启动中...' : '跳过样片，直接生成全部' }}
        </button>
      </div>
    </section>

    <!-- Step 4: 任务看板 -->
    <section v-if="step === 'dashboard'" class="card">
      <h2>生成进度</h2>
      <!-- 确认节点 4：样片确认 -->
      <div v-if="samplePendingConfirm" class="sample-confirm">
        <h3>样片确认</h3>
        <p class="hint">请确认首个样片效果，满意后再批量生成剩余分镜，避免整片返工。</p>
        <video v-if="sampleVideoUrl" :src="sampleVideoUrl" controls class="video-player sample"></video>
        <div class="btn-row">
          <button
            @click="confirmSampleAndGenerateAll"
            :disabled="actionLoading === 'start'"
            class="btn primary"
          >
            {{ actionLoading === 'start' ? '提交中...' : '确认样片，批量生成剩余分镜' }}
          </button>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressStats.percent + '%' }"></div>
      </div>
      <p class="progress-text">
        {{ progressStats.succeeded }}/{{ progressStats.total }} 完成
        <span v-if="progressStats.running > 0">· {{ progressStats.running }} 生成中</span>
        <span v-if="progressStats.failed > 0" class="failed-text">· {{ progressStats.failed }} 失败</span>
      </p>
      <div class="seg-grid">
        <div
          v-for="seg in segments"
          :key="seg.id"
          :class="['seg-cell', seg.status]"
          :title="seg.event"
        >
          #{{ seg.order }}
        </div>
      </div>
      <div class="btn-row">
        <button
          @click="generateSegments"
          :disabled="actionLoading === 'generate' || !segments.some((s) => s.status === 'prompt_ready')"
          class="btn"
        >
          {{ actionLoading === 'generate' ? '提交中...' : '重新提交待生成分镜' }}
        </button>
        <button
          @click="compose"
          :disabled="actionLoading === 'compose' || !segments.every((s) => s.status === 'succeeded' || s.status === 'approved')"
          class="btn primary"
        >
          {{ actionLoading === 'compose' ? '合成中...' : '导出成片（本地合成）' }}
        </button>
        <button
          @click="exportSegments"
          :disabled="actionLoading === 'export' || progressStats.succeeded === 0"
          class="btn"
        >
          {{ actionLoading === 'export' ? '打包中...' : '导出片段包（zip）' }}
        </button>
      </div>
    </section>

    <!-- 任务流水 -->
    <section v-if="step === 'dashboard' && jobs.length > 0" class="card">
      <h2>任务流水</h2>
      <div v-for="job in jobs" :key="job.id" class="job-row">
        <span :class="['job-status', job.status]">{{ job.status }}</span>
        <span class="job-kind">{{ job.kind }}</span>
        <span v-if="job.error" class="job-error">{{ job.error }}</span>
        <span class="job-time">{{ new Date(job.createdAt).toLocaleTimeString() }}</span>
      </div>
    </section>

    <section v-if="project?.finalVideoUrl" class="card">
      <h2>成片预览</h2>
      <video :src="project.finalVideoUrl" controls class="video-player"></video>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 20px;
  font-family: system-ui, -apple-system, sans-serif;
}
.header {
  display: flex;
  align-items: center;
  gap: 16px;
}
.back {
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
.error {
  color: #dc2626;
  background: #fef2f2;
  padding: 10px 14px;
  border-radius: 8px;
}
.steps {
  display: flex;
  gap: 8px;
  margin: 20px 0;
}
.step {
  flex: 1;
  text-align: center;
  padding: 8px 4px;
  border-radius: 8px;
  background: #f3f4f6;
  color: #9ca3af;
  font-size: 13px;
}
.step.active {
  background: #2563eb;
  color: #fff;
}
.step.done {
  background: #d1fae5;
  color: #065f46;
}
.card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}
.card h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
.card h3 {
  margin: 16px 0 8px;
  font-size: 15px;
}
.hint {
  color: #6b7280;
  font-size: 13px;
  margin: 4px 0 12px;
}
.btn {
  padding: 10px 20px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.btn-row {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}
.profile-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.profile-grid .span2 {
  grid-column: span 2;
}
.profile-grid b {
  display: block;
  color: #6b7280;
  font-size: 12px;
  margin-bottom: 2px;
}
.characters {
  margin-top: 8px;
}
.char-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 8px;
}
.char-card .role {
  margin-left: 8px;
  font-size: 12px;
  color: #2563eb;
  background: #eff6ff;
  padding: 2px 8px;
  border-radius: 10px;
}
.char-card .anchor {
  margin: 6px 0 0;
  font-size: 13px;
}
.char-card .relations {
  margin: 2px 0 0;
  font-size: 12px;
  color: #6b7280;
}
.slice {
  border-left: 3px solid #2563eb;
  padding: 8px 14px;
  margin-bottom: 12px;
  background: #f9fafb;
  border-radius: 0 8px 8px 0;
}
.slice-head {
  display: flex;
  gap: 10px;
  align-items: center;
}
.emotion {
  font-size: 12px;
  background: #fef3c7;
  color: #92400e;
  padding: 1px 8px;
  border-radius: 10px;
}
.duration {
  margin-left: auto;
  font-size: 12px;
  color: #6b7280;
}
.event {
  font-weight: 600;
  margin: 6px 0 2px;
}
.slice-text {
  font-size: 13px;
  color: #4b5563;
  margin: 4px 0;
}
.slice-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #6b7280;
}
.estimate .est-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px dashed #e5e7eb;
}
.est-row.total {
  font-size: 17px;
  border-bottom: none;
}
.progress-bar {
  height: 10px;
  background: #e5e7eb;
  border-radius: 5px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: #2563eb;
  transition: width 0.5s;
}
.progress-text {
  margin: 8px 0 16px;
  font-size: 14px;
}
.failed-text {
  color: #dc2626;
}
.seg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 8px;
}
.seg-cell {
  text-align: center;
  padding: 10px 4px;
  border-radius: 8px;
  background: #f3f4f6;
  font-size: 13px;
}
.seg-cell.succeeded,
.seg-cell.approved {
  background: #d1fae5;
  color: #065f46;
}
.seg-cell.queued,
.seg-cell.submitted,
.seg-cell.polling {
  background: #dbeafe;
  color: #1d4ed8;
}
.seg-cell.failed,
.seg-cell.rejected {
  background: #fee2e2;
  color: #b91c1c;
}
.job-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px dashed #f3f4f6;
  font-size: 13px;
}
.job-status {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
}
.job-status.succeeded {
  background: #d1fae5;
  color: #065f46;
}
.job-status.running,
.job-status.queued {
  background: #dbeafe;
  color: #1d4ed8;
}
.job-status.failed {
  background: #fee2e2;
  color: #b91c1c;
}
.job-kind {
  color: #4b5563;
}
.job-error {
  color: #dc2626;
  font-size: 12px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-time {
  margin-left: auto;
  color: #9ca3af;
  font-size: 12px;
}
.video-player {
  width: 100%;
  max-height: 480px;
  border-radius: 8px;
}
.video-player.sample {
  max-height: 360px;
  margin-bottom: 8px;
}
.asset-section {
  margin-top: 16px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 12px;
}
.asset-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
}
.asset-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.asset-kind {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 10px;
}
.asset-kind.character {
  background: #ede9fe;
  color: #5b21b6;
}
.asset-kind.scene {
  background: #d1fae5;
  color: #065f46;
}
.asset-done {
  margin-left: auto;
  font-size: 12px;
  color: #059669;
}
.asset-desc {
  margin: 6px 0;
  font-size: 13px;
  color: #4b5563;
}
.candidate-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 8px;
}
.asset-img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: 8px;
  border: 2px solid transparent;
}
.asset-img.candidate {
  cursor: pointer;
  border-color: #e5e7eb;
}
.asset-img.candidate:hover {
  border-color: #2563eb;
}
.asset-img.selected {
  border-color: #059669;
}
.btn.small {
  padding: 6px 12px;
  font-size: 13px;
}
.sample-confirm {
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
}
.sample-confirm h3 {
  margin: 0 0 4px;
}
</style>
