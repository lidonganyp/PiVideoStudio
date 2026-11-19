<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type Asset } from '../api';

const projectId = ref('');
const assets = ref<Asset[]>([]);
const loading = ref(false);
const error = ref('');
const filter = ref<'all' | 'character' | 'scene'>('all');
const editingAsset = ref<Asset | null>(null);
const voiceIdInput = ref('');

const filteredAssets = computed(() =>
  filter.value === 'all' ? assets.value : assets.value.filter((a) => a.kind === filter.value),
);
const characters = computed(() => assets.value.filter((a) => a.kind === 'character'));
const scenes = computed(() => assets.value.filter((a) => a.kind === 'scene'));

async function loadAssets() {
  if (!projectId.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    assets.value = await api.getAssets(projectId.value.trim());
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function generateImages(asset: Asset) {
  try {
    await api.generateImages(asset.id);
    await loadAssets();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function selectImage(asset: Asset, imagePath: string) {
  try {
    await api.selectImage(asset.id, imagePath);
    await loadAssets();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function editVoiceId(asset: Asset) {
  editingAsset.value = asset;
  voiceIdInput.value = (asset as any).voiceId ?? '';
}

onMounted(() => {});
</script>

<template>
  <div class="asset-library">
    <div class="header">
      <h2>资产库</h2>
      <div class="project-input">
        <input v-model="projectId" placeholder="项目 ID" @keyup.enter="loadAssets" />
        <button class="btn-primary" @click="loadAssets" :disabled="loading">加载</button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="assets.length > 0" class="content">
      <div class="filter-bar">
        <button v-for="f in ['all','character','scene']" :key="f"
          :class="['filter-btn', { active: filter === f }]"
          @click="filter = f as typeof filter"
        >{{ f === 'character' ? '角色' : f === 'scene' ? '场景' : '全部' }}</button>
      </div>

      <div class="asset-grid">
        <div v-for="asset in filteredAssets" :key="asset.id" class="asset-card">
          <div class="asset-header">
            <span class="asset-kind" :class="asset.kind">{{ asset.kind === 'character' ? '角色' : '场景' }}</span>
            <span class="asset-name">{{ asset.name }}</span>
          </div>
          <div class="asset-desc">{{ asset.description }}</div>
          <div v-if="asset.referenceImagePath" class="asset-image">
            <img :src="'/' + asset.referenceImagePath" :alt="asset.name" />
          </div>
          <div v-if="asset.candidateImages?.length" class="candidates">
            <div v-for="img in asset.candidateImages" :key="img" class="candidate"
              @click="selectImage(asset, img)">
              <img :src="'/' + img" :alt="asset.name" />
            </div>
          </div>
          <div class="asset-actions">
            <button class="btn-small" @click="generateImages(asset)">生成参考图</button>
            <button v-if="asset.kind === 'character'" class="btn-small" @click="editVoiceId(asset)">音色绑定</button>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!loading" class="empty">输入项目 ID 并加载，查看角色/场景圣经</div>

    <div v-if="editingAsset" class="modal" @click.self="editingAsset = null">
      <div class="modal-content">
        <h3>音色绑定：{{ editingAsset.name }}</h3>
        <p class="hint">输入 EdgeTTS 音色 ID（如 zh-CN-XiaoxiaoNeural），主角音色将跨集锁定。</p>
        <input v-model="voiceIdInput" placeholder="音色 ID" />
        <div class="modal-actions">
          <button class="btn-primary" @click="editingAsset = null">保存</button>
          <button class="btn-secondary" @click="editingAsset = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.asset-library { padding: 20px; max-width: 1400px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h2 { margin: 0; }
.project-input { display: flex; gap: 8px; }
.project-input input { padding: 6px 12px; border: 1px solid #dcdfe6; border-radius: 4px; width: 240px; }
.filter-bar { display: flex; gap: 4px; margin-bottom: 16px; }
.filter-btn { padding: 4px 12px; border: 1px solid #dcdfe6; border-radius: 4px; background: white; cursor: pointer; font-size: 13px; }
.filter-btn.active { background: #409eff; color: white; border-color: #409eff; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.asset-card { border: 1px solid #e4e7ed; border-radius: 8px; padding: 16px; }
.asset-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.asset-kind { padding: 2px 8px; border-radius: 4px; font-size: 11px; color: white; }
.asset-kind.character { background: #409eff; }
.asset-kind.scene { background: #67c23a; }
.asset-name { font-weight: 600; font-size: 14px; }
.asset-desc { font-size: 12px; color: #606266; margin-bottom: 8px; max-height: 60px; overflow-y: auto; }
.asset-image img { width: 100%; border-radius: 4px; margin-bottom: 8px; }
.candidates { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
.candidate { width: 48px; height: 48px; border: 1px solid #dcdfe6; border-radius: 4px; overflow: hidden; cursor: pointer; }
.candidate img { width: 100%; height: 100%; object-fit: cover; }
.candidate:hover { border-color: #409eff; }
.asset-actions { display: flex; gap: 8px; }
.btn-primary { background: #409eff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.btn-primary:disabled { background: #c0c4cc; cursor: not-allowed; }
.btn-small { background: #f4f4f5; color: #606266; border: 1px solid #dcdfe6; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-secondary { background: #f4f4f5; color: #606266; border: 1px solid #dcdfe6; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.error { color: #f56c6c; margin-bottom: 12px; padding: 8px 12px; background: #fef0f0; border-radius: 4px; }
.empty { text-align: center; color: #909399; padding: 48px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-content { background: white; border-radius: 8px; padding: 24px; width: 400px; }
.modal-content input { width: 100%; padding: 8px; border: 1px solid #dcdfe6; border-radius: 4px; box-sizing: border-box; margin-bottom: 16px; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
.hint { font-size: 12px; color: #909399; margin-bottom: 12px; }
</style>
