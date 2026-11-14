<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Project, type Segment } from '../api';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const project = ref<Project | null>(null);
const segments = ref<Segment[]>([]);
const loading = ref(false);
const error = ref('');
const actionLoading = ref('');

async function loadData() {
  loading.value = true;
  try {
    const [p, segs] = await Promise.all([
      api.getProject(projectId),
      api.getSegments(projectId),
    ]);
    project.value = p;
    segments.value = segs;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

const canSplit = computed(() => project.value?.status === 'planning');
const canBuildPrompts = computed(
  () => segments.value.length > 0 && segments.value.some((s) => s.status === 'draft'),
);
const canGenerate = computed(
  () => segments.value.some((s) => s.status === 'prompt_ready'),
);
const canCompose = computed(
  () =>
    segments.value.length > 0 &&
    segments.value.every((s) => s.status === 'succeeded'),
);

async function doAction(
  name: string,
  fn: (id: string) => Promise<unknown>,
) {
  actionLoading.value = name;
  error.value = '';
  try {
    await fn(projectId);
    await loadData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoading.value = '';
  }
}

const splitText = () =>
  doAction('split', (id) => api.splitText(id));
const buildPrompts = () =>
  doAction('prompts', (id) => api.buildPrompts(id));
const generateSegments = () =>
  doAction('generate', (id) => api.generateSegments(id));
const compose = () =>
  doAction('compose', (id) => api.compose(id));

onMounted(loadData);
</script>

<template>
  <div class="page">
    <div class="header">
      <button @click="router.push('/')" class="back">← 返回</button>
      <h1>{{ project?.title ?? '加载中...' }}</h1>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="project" class="info">
      <span>状态: {{ project.status }}</span>
      <span>风格: {{ project.style }}</span>
      <span>画幅: {{ project.aspectRatio }}</span>
    </div>

    <div class="actions">
      <button
        @click="splitText"
        :disabled="!canSplit || actionLoading === 'split'"
        class="btn"
      >
        {{ actionLoading === 'split' ? '拆分中...' : '文本拆分' }}
      </button>
      <button
        @click="buildPrompts"
        :disabled="!canBuildPrompts || actionLoading === 'prompts'"
        class="btn"
      >
        {{ actionLoading === 'prompts' ? '生成中...' : '生成提示词' }}
      </button>
      <button
        @click="generateSegments"
        :disabled="!canGenerate || actionLoading === 'generate'"
        class="btn"
      >
        {{ actionLoading === 'generate' ? '提交中...' : '生成片段' }}
      </button>
      <button
        @click="compose"
        :disabled="!canCompose || actionLoading === 'compose'"
        class="btn"
      >
        {{ actionLoading === 'compose' ? '合成中...' : '合成成片' }}
      </button>
    </div>

    <section v-if="segments.length > 0" class="segments">
      <h2>分镜列表 ({{ segments.length }})</h2>
      <div v-for="seg in segments" :key="seg.id" class="segment">
        <div class="seg-header">
          <strong>#{{ seg.order }}</strong>
          <span class="status-badge" :class="seg.status">{{ seg.status }}</span>
          <span class="duration">{{ seg.estimatedSeconds }}s</span>
        </div>
        <p class="seg-text">{{ seg.sourceText }}</p>
        <div v-if="seg.prompt" class="seg-prompt">
          <details>
            <summary>提示词包</summary>
            <p><b>镜头:</b> {{ seg.prompt.camera }}</p>
            <p><b>画面:</b> {{ seg.prompt.visual }}</p>
            <p><b>旁白:</b> {{ seg.prompt.narration }}</p>
          </details>
        </div>
      </div>
    </section>

    <section v-if="project?.finalVideoUrl" class="player">
      <h2>成片预览</h2>
      <video
        :src="project.finalVideoUrl"
        controls
        autoplay
        class="video-player"
      ></video>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 900px;
  margin: 0 auto;
  padding: 40px 20px;
  font-family: system-ui, -apple-system, sans-serif;
}
.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
.back {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
}
.info {
  display: flex;
  gap: 20px;
  color: #6b7280;
  font-size: 14px;
  margin-bottom: 20px;
}
.actions {
  display: flex;
  gap: 12px;
  margin-bottom: 32px;
  flex-wrap: wrap;
}
.btn {
  padding: 10px 20px;
  background: #3b82f6;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: #2563eb;
}
.btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
.segments {
  margin-bottom: 32px;
}
.segment {
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 12px;
}
.seg-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: #e5e7eb;
}
.status-badge.succeeded {
  background: #d1fae5;
  color: #065f46;
}
.status-badge.failed {
  background: #fee2e2;
  color: #991b1b;
}
.duration {
  color: #6b7280;
  font-size: 13px;
}
.seg-text {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.6;
}
.seg-prompt details summary {
  cursor: pointer;
  font-size: 13px;
  color: #6b7280;
}
.seg-prompt p {
  margin: 4px 0;
  font-size: 13px;
}
.player {
  margin-top: 32px;
}
.video-player {
  width: 100%;
  max-width: 480px;
  border-radius: 12px;
}
.error {
  color: #ef4444;
  padding: 8px 0;
}
</style>
