<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { api, type Series, type Project, type ModelRouteTable } from '../api';

const router = useRouter();
const seriesList = ref<Series[]>([]);
const projects = ref<Project[]>([]);
const loading = ref(false);
const error = ref('');
const showCreate = ref(false);
const newSeries = ref({ title: '', novelProjectId: '', episodeCount: 30, storyBible: '' });
const selectedSeriesId = ref('');
const routeTable = ref<ModelRouteTable | null>(null);

const selectedSeries = computed(() =>
  seriesList.value.find((s) => s.id === selectedSeriesId.value),
);
const seriesProjects = computed(() =>
  selectedSeriesId.value
    ? projects.value.filter((p) => p.title.includes(selectedSeries.value?.title ?? ''))
    : [],
);

async function loadSeries() {
  loading.value = true;
  error.value = '';
  try {
    seriesList.value = await api.listSeries();
    projects.value = await api.listProjects();
    if (seriesList.value.length > 0 && !selectedSeriesId.value) {
      selectedSeriesId.value = seriesList.value[0].id;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function loadRouteTable() {
  try {
    routeTable.value = await api.getModelRoutes();
  } catch {
    // 静默忽略
  }
}

async function createSeries() {
  if (!newSeries.value.title.trim()) {
    error.value = '请输入剧集标题';
    return;
  }
  try {
    const res = await api.createSeries({
      title: newSeries.value.title.trim(),
      novelProjectId: newSeries.value.novelProjectId || undefined,
      episodeCount: newSeries.value.episodeCount,
      storyBible: newSeries.value.storyBible || undefined,
    });
    seriesList.value.unshift(res.series);
    selectedSeriesId.value = res.series.id;
    showCreate.value = false;
    newSeries.value = { title: '', novelProjectId: '', episodeCount: 30, storyBible: '' };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function updateStoryBible() {
  if (!selectedSeries.value) return;
  try {
    await api.updateSeries(selectedSeries.value.id, {
      storyBible: selectedSeries.value.storyBible,
      episodeCount: selectedSeries.value.episodeCount,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function goToProject(id: string) {
  router.push(`/projects/${id}`);
}

const statusColors: Record<string, string> = {
  planning: '#909399',
  splitting: '#409eff',
  asset_extracting: '#409eff',
  prompt_building: '#409eff',
  segment_generating: '#e6a23c',
  reviewing: '#e6a23c',
  composing: '#e6a23c',
  delivering: '#67c23a',
  done: '#67c23a',
  failed: '#f56c6c',
};

onMounted(() => {
  loadSeries();
  loadRouteTable();
});
</script>

<template>
  <div class="series-workbench">
    <div class="header">
      <h2>剧集工作台</h2>
      <button class="btn-primary" @click="showCreate = true">+ 新建剧集</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="layout">
      <div class="sidebar">
        <div
          v-for="s in seriesList"
          :key="s.id"
          class="series-card"
          :class="{ active: s.id === selectedSeriesId }"
          @click="selectedSeriesId = s.id"
        >
          <div class="series-title">{{ s.title }}</div>
          <div class="series-meta">{{ s.episodeCount }} 集 · {{ new Date(s.createdAt).toLocaleDateString() }}</div>
        </div>
      </div>

      <div v-if="selectedSeries" class="main">
        <div class="section">
          <h3>{{ selectedSeries.title }}</h3>
          <div class="series-info">
            <label>集数：<input v-model.number="selectedSeries.episodeCount" type="number" /></label>
            <button class="btn-small" @click="updateStoryBible">保存</button>
          </div>
          <div class="story-bible">
            <label>Story Bible（全局层：伏笔/人物弧线/时间线）</label>
            <textarea v-model="selectedSeries.storyBible" rows="6" placeholder="输入 Story Bible 全局层内容..." />
          </div>
        </div>

        <div class="section">
          <h3>集列表（{{ seriesProjects.length }}）</h3>
          <div class="episode-grid">
            <div
              v-for="p in seriesProjects"
              :key="p.id"
              class="episode-card"
              @click="goToProject(p.id)"
            >
              <div class="ep-title">{{ p.title }}</div>
              <div class="ep-status" :style="{ color: statusColors[p.status] || '#909399' }">
                {{ p.status }}
              </div>
            </div>
            <div v-if="seriesProjects.length === 0" class="empty">
              暂无集，请在项目列表创建后关联到此剧集
            </div>
          </div>
        </div>

        <div v-if="routeTable" class="section">
          <h3>模型路由（{{ routeTable.tier }} 档位）</h3>
          <div class="route-table">
            <div v-for="(route, cls) in routeTable.routes" :key="cls" class="route-row">
              <span class="route-class">{{ cls }}</span>
              <span class="route-model">{{ route.provider }} / {{ route.model }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showCreate" class="modal" @click.self="showCreate = false">
      <div class="modal-content">
        <h3>新建剧集</h3>
        <div class="form-group">
          <label>标题</label>
          <input v-model="newSeries.title" placeholder="剧集标题" />
        </div>
        <div class="form-group">
          <label>集数</label>
          <input v-model.number="newSeries.episodeCount" type="number" />
        </div>
        <div class="form-group">
          <label>小说项目 ID（可选）</label>
          <input v-model="newSeries.novelProjectId" placeholder="PiNovelStudio 项目 ID" />
        </div>
        <div class="form-group">
          <label>Story Bible（可选）</label>
          <textarea v-model="newSeries.storyBible" rows="4" placeholder="伏笔/人物弧线/时间线..." />
        </div>
        <div class="modal-actions">
          <button class="btn-primary" @click="createSeries">创建</button>
          <button class="btn-secondary" @click="showCreate = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.series-workbench { padding: 20px; max-width: 1400px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h2 { margin: 0; }
.layout { display: flex; gap: 20px; }
.sidebar { width: 240px; flex-shrink: 0; }
.series-card { padding: 12px; border: 1px solid #e4e7ed; border-radius: 6px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.2s; }
.series-card.active { border-color: #409eff; background: #ecf5ff; }
.series-card:hover { border-color: #c0c4cc; }
.series-title { font-weight: 600; font-size: 14px; }
.series-meta { font-size: 12px; color: #909399; margin-top: 4px; }
.main { flex: 1; min-width: 0; }
.section { margin-bottom: 24px; }
.section h3 { margin: 0 0 12px; font-size: 16px; }
.series-info { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.series-info input { padding: 4px 8px; border: 1px solid #dcdfe6; border-radius: 4px; width: 80px; }
.story-bible textarea { width: 100%; padding: 8px; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 13px; resize: vertical; }
.episode-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.episode-card { padding: 12px; border: 1px solid #e4e7ed; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
.episode-card:hover { border-color: #409eff; box-shadow: 0 2px 8px rgba(64,158,255,0.1); }
.ep-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ep-status { font-size: 11px; margin-top: 4px; }
.empty { grid-column: 1 / -1; text-align: center; color: #909399; padding: 24px; }
.route-table { display: flex; flex-direction: column; gap: 6px; }
.route-row { display: flex; gap: 12px; padding: 6px 12px; background: #f5f7fa; border-radius: 4px; }
.route-class { font-weight: 600; width: 100px; }
.route-model { color: #606266; }
.btn-primary { background: #409eff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-primary:hover { background: #66b1ff; }
.btn-secondary { background: #f4f4f5; color: #606266; border: 1px solid #dcdfe6; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-small { background: #409eff; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.error { color: #f56c6c; margin-bottom: 12px; padding: 8px 12px; background: #fef0f0; border-radius: 4px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-content { background: white; border-radius: 8px; padding: 24px; width: 480px; max-width: 90vw; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; margin-bottom: 4px; font-size: 13px; color: #606266; }
.form-group input, .form-group textarea { width: 100%; padding: 8px; border: 1px solid #dcdfe6; border-radius: 4px; box-sizing: border-box; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
</style>
