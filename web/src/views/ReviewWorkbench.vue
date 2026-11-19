<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted } from 'vue';
import { api, type Segment, type Job } from '../api';

const projectId = ref('');
const segments = ref<Segment[]>([]);
const jobs = ref<Job[]>([]);
const loading = ref(false);
const error = ref('');
const currentIndex = ref(0);
const filter = ref<'all' | 'succeeded' | 'suspect' | 'failed'>('succeeded');

const current = computed(() => filteredSegments.value[currentIndex.value]);

const filteredSegments = computed(() => {
  if (filter.value === 'all') return segments.value;
  if (filter.value === 'suspect') {
    const suspectIds = new Set(jobs.value.filter((j) => j.qcResult === 'suspect').map((j) => j.segmentId));
    return segments.value.filter((s) => suspectIds.has(s.id));
  }
  if (filter.value === 'failed') return segments.value.filter((s) => s.status === 'failed');
  return segments.value.filter((s) => s.status === 'succeeded');
});

const currentJob = computed(() =>
  current.value ? jobs.value.find((j) => j.segmentId === current.value.id && j.status === 'succeeded') : undefined,
);

async function loadData() {
  if (!projectId.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    segments.value = await api.getSegments(projectId.value.trim());
    jobs.value = await api.getJobs(projectId.value.trim());
    currentIndex.value = 0;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function approve() {
  if (!current.value) return;
  try {
    await api.approveSegment(current.value.id);
    await loadData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function reject() {
  if (!current.value) return;
  try {
    await api.regenerateSegment(current.value.id);
    await loadData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function regenerateDraft() {
  if (!current.value) return;
  try {
    await api.regenerateSegment(current.value.id, { draft: true });
    await loadData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function next() {
  if (currentIndex.value < filteredSegments.value.length - 1) currentIndex.value++;
}
function prev() {
  if (currentIndex.value > 0) currentIndex.value--;
}

function handleKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') next();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'a' || e.key === 'A') approve();
  else if (e.key === 'r' || e.key === 'R') reject();
}

onMounted(() => {
  window.addEventListener('keydown', handleKey);
});
onUnmounted(() => {
  window.removeEventListener('keydown', handleKey);
});

const qcBadge: Record<string, string> = {
  approved: '#67c23a',
  suspect: '#e6a23c',
  rejected: '#f56c6c',
};
</script>

<template>
  <div class="review-workbench">
    <div class="header">
      <h2>批量审核台</h2>
      <div class="project-input">
        <input v-model="projectId" placeholder="项目 ID" @keyup.enter="loadData" />
        <button class="btn-primary" @click="loadData" :disabled="loading">加载</button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="filteredSegments.length > 0" class="layout">
      <div class="sidebar">
        <div class="filter-bar">
          <button v-for="f in ['all','succeeded','suspect','failed']" :key="f"
            :class="['filter-btn', { active: filter === f }]"
            @click="filter = f as typeof filter; currentIndex = 0"
          >{{ f }}</button>
        </div>
        <div class="segment-list">
          <div v-for="(seg, i) in filteredSegments" :key="seg.id"
            :class="['seg-item', { active: i === currentIndex }]"
            @click="currentIndex = i"
          >
            <span class="seg-order">#{{ seg.order }}</span>
            <span class="seg-status" :style="{ color: seg.status === 'succeeded' ? '#67c23a' : seg.status === 'failed' ? '#f56c6c' : '#909399' }">{{ seg.status }}</span>
          </div>
        </div>
      </div>

      <div v-if="current" class="main">
        <div class="seg-header">
          <h3>块 #{{ current.order }} · {{ current.sceneSummary }}</h3>
          <div v-if="currentJob?.qcResult" class="qc-badge" :style="{ background: qcBadge[currentJob.qcResult] }">
            QC: {{ currentJob.qcResult }}
          </div>
          <div v-if="currentJob?.providerModel" class="model-tag">{{ currentJob.providerModel }}</div>
        </div>

        <div class="seg-content">
          <div class="seg-text">
            <div class="field"><label>事件</label><p>{{ current.event }}</p></div>
            <div class="field"><label>角色状态</label><p>{{ current.characterState }}</p></div>
            <div class="field"><label>旁白</label><p>{{ current.prompt?.narration }}</p></div>
            <div class="field"><label>画面提示词</label><pre>{{ current.prompt?.visual }}</pre></div>
          </div>
        </div>

        <div class="actions">
          <button class="btn-approve" @click="approve" :disabled="current.status !== 'succeeded'">通过 (A)</button>
          <button class="btn-reject" @click="reject" :disabled="current.status !== 'succeeded' && current.status !== 'failed'">驳回重生成 (R)</button>
          <button class="btn-draft" @click="regenerateDraft" :disabled="current.status !== 'succeeded' && current.status !== 'failed'">草稿重生成</button>
          <button class="btn-nav" @click="prev" :disabled="currentIndex === 0">← 上一个</button>
          <button class="btn-nav" @click="next" :disabled="currentIndex >= filteredSegments.length - 1">下一个 →</button>
        </div>
        <div class="hint">快捷键：← → 切换，A 通过，R 驳回</div>
      </div>
    </div>
    <div v-else-if="!loading" class="empty">输入项目 ID 并加载，查看待审核片段</div>
  </div>
</template>

<style scoped>
.review-workbench { padding: 20px; max-width: 1400px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h2 { margin: 0; }
.project-input { display: flex; gap: 8px; }
.project-input input { padding: 6px 12px; border: 1px solid #dcdfe6; border-radius: 4px; width: 240px; }
.layout { display: flex; gap: 20px; }
.sidebar { width: 200px; flex-shrink: 0; }
.filter-bar { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
.filter-btn { padding: 4px 8px; border: 1px solid #dcdfe6; border-radius: 4px; background: white; cursor: pointer; font-size: 12px; }
.filter-btn.active { background: #409eff; color: white; border-color: #409eff; }
.segment-list { max-height: 600px; overflow-y: auto; }
.seg-item { display: flex; justify-content: space-between; padding: 8px 12px; border: 1px solid #e4e7ed; border-radius: 4px; margin-bottom: 4px; cursor: pointer; }
.seg-item.active { border-color: #409eff; background: #ecf5ff; }
.seg-order { font-weight: 600; font-size: 13px; }
.seg-status { font-size: 11px; }
.main { flex: 1; min-width: 0; }
.seg-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.seg-header h3 { margin: 0; font-size: 16px; }
.qc-badge { padding: 2px 8px; border-radius: 4px; color: white; font-size: 12px; }
.model-tag { padding: 2px 8px; background: #f4f4f5; border-radius: 4px; font-size: 12px; color: #606266; }
.seg-content { background: #f5f7fa; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.field { margin-bottom: 12px; }
.field label { font-weight: 600; font-size: 12px; color: #909399; display: block; margin-bottom: 4px; }
.field p { margin: 0; font-size: 14px; }
.field pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn-primary, .btn-approve { background: #67c23a; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-approve:hover { background: #85ce61; }
.btn-approve:disabled { background: #c0c4cc; cursor: not-allowed; }
.btn-reject { background: #f56c6c; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-reject:hover { background: #f78989; }
.btn-reject:disabled { background: #c0c4cc; cursor: not-allowed; }
.btn-draft { background: #909399; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-draft:hover { background: #a6a9ad; }
.btn-draft:disabled { background: #c0c4cc; cursor: not-allowed; }
.btn-nav { background: #f4f4f5; color: #606266; border: 1px solid #dcdfe6; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-nav:disabled { color: #c0c4cc; cursor: not-allowed; }
.btn-primary { background: #409eff; }
.btn-primary:disabled { background: #c0c4cc; cursor: not-allowed; }
.hint { margin-top: 8px; font-size: 12px; color: #909399; }
.error { color: #f56c6c; margin-bottom: 12px; padding: 8px 12px; background: #fef0f0; border-radius: 4px; }
.empty { text-align: center; color: #909399; padding: 48px; }
</style>
