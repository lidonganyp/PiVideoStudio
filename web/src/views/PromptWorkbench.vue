<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type Segment } from '../api';

const projectId = ref('');
const segments = ref<Segment[]>([]);
const loading = ref(false);
const error = ref('');
const selectedSegmentId = ref('');

const MODULES = [
  { key: 'sceneContext', title: 'SCENE CONTEXT' },
  { key: 'activeReferences', title: 'ACTIVE REFERENCES' },
  { key: 'locationMap', title: 'LOCATION MAP' },
  { key: 'firstFrameBlocking', title: 'FIRST FRAME & BLOCKING' },
  { key: 'formatMode', title: 'FORMAT' },
  { key: 'optics', title: 'OPTICS' },
  { key: 'camera', title: 'CAMERA' },
  { key: 'actionTimeline', title: 'ACTION TIMELINE' },
  { key: 'physics', title: 'PHYSICS' },
  { key: 'lighting', title: 'LIGHTING' },
  { key: 'audio', title: 'AUDIO' },
  { key: 'style', title: 'STYLE' },
];

const current = computed(() => segments.value.find((s) => s.id === selectedSegmentId.value));

const shots = computed(() => {
  if (!current.value?.shots) return [];
  try {
    return Array.isArray(current.value.shots) ? current.value.shots : JSON.parse(current.value.shots as string);
  } catch { return []; }
});

const promptV2Modules = computed(() => {
  if (!current.value?.promptV2) return null;
  try {
    return typeof current.value.promptV2 === 'string' ? JSON.parse(current.value.promptV2 as string) : current.value.promptV2;
  } catch { return null; }
});

async function loadData() {
  if (!projectId.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    segments.value = await api.getSegments(projectId.value.trim());
    if (segments.value.length > 0) selectedSegmentId.value = segments.value[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function parseTimeRange(range: string): { start: number; end: number } {
  const m = range.match(/(\\d+)-(\\d+)s/);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : { start: 0, end: 0 };
}

const totalDuration = computed(() => {
  if (shots.value.length === 0) return 0;
  return parseTimeRange(shots.value[shots.value.length - 1].timeRange).end;
});
</script>

<template>
  <div class="prompt-workbench">
    <div class="header">
      <h2>Prompt Workbench</h2>
      <div class="project-input">
        <input v-model="projectId" placeholder="Project ID" @keyup.enter="loadData" />
        <button class="btn-primary" @click="loadData" :disabled="loading">Load</button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="segments.length > 0" class="layout">
      <div class="sidebar">
        <div v-for="seg in segments" :key="seg.id" :class="['seg-item', { active: seg.id === selectedSegmentId }]" @click="selectedSegmentId = seg.id">
          <span class="seg-order">#{{ seg.order }}</span>
          <span class="seg-summary">{{ seg.sceneSummary }}</span>
        </div>
      </div>

      <div v-if="current" class="main">
        <div class="seg-header">
          <h3>#{{ current.order }} {{ current.sceneSummary }}</h3>
          <span class="seg-meta">{{ current.estimatedSeconds }}s | {{ current.shotClass || 'N/A' }}</span>
        </div>

        <div v-if="shots.length > 0" class="timeline-section">
          <h4>Shot Timeline</h4>
          <div class="timeline">
            <div v-for="shot in shots" :key="shot.shotNo" class="shot-block" :style="{ flex: parseTimeRange(shot.timeRange).end - parseTimeRange(shot.timeRange).start }">
              <div class="shot-time">{{ shot.timeRange }}</div>
              <div class="shot-type">{{ shot.shotType }}</div>
              <div class="shot-move">{{ shot.cameraMovement }}</div>
              <div class="shot-action">{{ shot.action }}</div>
            </div>
          </div>
          <div class="timeline-axis"><span>0s</span><span>{{ totalDuration }}s</span></div>
        </div>
        <div v-if="promptV2Modules" class="modules-section">
          <h4>12-Module Structured Prompt</h4>
          <div class="modules-grid">
            <div v-for="mod in MODULES" :key="mod.key" class="module-card">
              <div class="module-title">{{ mod.title }}</div>
              <pre class="module-content">{{ promptV2Modules.modules?.[mod.key] || '(empty)' }}</pre>
            </div>
          </div>
          <div class="negative-section">
            <div class="module-title">NEGATIVE</div>
            <pre class="module-content">{{ promptV2Modules.negative || '(empty)' }}</pre>
          </div>
        </div>

        <div v-else class="legacy-prompt">
          <h4>Legacy Prompt (pre-v1.1)</h4>
          <div class="field"><label>Visual</label><pre>{{ current.prompt?.visual }}</pre></div>
          <div class="field"><label>Camera</label><pre>{{ current.prompt?.camera }}</pre></div>
          <div class="field"><label>Narration</label><pre>{{ current.prompt?.narration }}</pre></div>
          <div class="field"><label>Subtitle</label><pre>{{ current.prompt?.subtitle }}</pre></div>
        </div>
      </div>
    </div>

    <div v-else-if="!loading" class="empty"><p>Enter a Project ID to load segments.</p></div>
  </div>
</template>

<style scoped>
.prompt-workbench { padding: 20px; max-width: 1400px; margin: 0 auto; }
.header { display: flex; align-items: center; gap: 20px; margin-bottom: 20px; }
.header h2 { margin: 0; font-size: 1.5rem; }
.project-input { display: flex; gap: 8px; }
.project-input input { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; width: 240px; }
.btn-primary { padding: 6px 16px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: #f56c6c; margin-bottom: 12px; }
.layout { display: flex; gap: 16px; }
.sidebar { width: 240px; flex-shrink: 0; max-height: 70vh; overflow-y: auto; border: 1px solid #ebeef5; border-radius: 4px; }
.seg-item { padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0; display: flex; gap: 8px; align-items: center; }
.seg-item:hover { background: #f5f7fa; }
.seg-item.active { background: #ecf5ff; border-left: 3px solid #409eff; }
.seg-order { font-weight: bold; color: #909399; font-size: 0.85rem; }
.seg-summary { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { flex: 1; min-width: 0; }
.seg-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.seg-header h3 { margin: 0; font-size: 1.1rem; }
.seg-meta { font-size: 0.85rem; color: #909399; }
.timeline-section { margin-bottom: 24px; }
.timeline-section h4 { margin: 0 0 8px 0; font-size: 0.95rem; }
.timeline { display: flex; gap: 2px; height: 80px; align-items: stretch; }
.shot-block { background: #e8f4ff; border: 1px solid #d4e8fc; border-radius: 4px; padding: 4px 6px; font-size: 0.7rem; display: flex; flex-direction: column; justify-content: space-between; min-width: 60px; overflow: hidden; }
.shot-time { font-weight: bold; color: #409eff; }
.shot-type { color: #606266; }
.shot-move { color: #909399; }
.shot-action { color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-axis { display: flex; justify-content: space-between; margin-top: 4px; font-size: 0.75rem; color: #c0c4cc; }
.modules-section { margin-bottom: 24px; }
.modules-section h4 { margin: 0 0 12px 0; font-size: 0.95rem; }
.modules-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.module-card { border: 1px solid #ebeef5; border-radius: 4px; overflow: hidden; }
.module-title { background: #f5f7fa; padding: 6px 10px; font-size: 0.8rem; font-weight: bold; color: #303133; }
.module-content { padding: 8px 10px; font-size: 0.78rem; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; margin: 0; }
.negative-section { margin-top: 12px; border: 1px solid #fde2e2; border-radius: 4px; overflow: hidden; }
.negative-section .module-title { background: #fef0f0; color: #f56c6c; }
.legacy-prompt { border: 1px dashed #e6e8ed; border-radius: 4px; padding: 16px; }
.legacy-prompt h4 { margin: 0 0 12px 0; color: #909399; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 0.8rem; color: #909399; margin-bottom: 4px; }
.field pre { margin: 0; padding: 8px; background: #f5f7fa; border-radius: 4px; font-size: 0.82rem; white-space: pre-wrap; word-break: break-word; }
.empty { text-align: center; padding: 60px; color: #c0c4cc; }
</style>
