<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  api,
  pinovelApi,
  type Project,
  type NovelProject,
  type NovelChapter,
} from '../api';

const router = useRouter();
const projects = ref<Project[]>([]);
const loading = ref(false);
const error = ref('');

const form = ref({
  title: '',
  style: 'narration',
  aspectRatio: '9:16',
  rawText: '',
});

// ---- PiNovelStudio 章节来源（B5）----
const pinovelEmail = ref('');
const pinovelPassword = ref('');
const pinovelToken = ref(localStorage.getItem('pinovel_token') ?? '');
const pinovelLoading = ref(false);
const novelProjects = ref<NovelProject[]>([]);
const novelChapters = ref<NovelChapter[]>([]);
const selectedNovelProjectId = ref('');
const selectedChapterIds = ref<Set<number>>(new Set());

async function loadProjects() {
  loading.value = true;
  try {
    projects.value = await api.listProjects();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function loginPinovel() {
  if (!pinovelEmail.value.trim() || !pinovelPassword.value) {
    error.value = '请输入 PiNovelStudio 邮箱与密码';
    return;
  }
  pinovelLoading.value = true;
  error.value = '';
  try {
    const res = await pinovelApi.login(pinovelEmail.value.trim(), pinovelPassword.value);
    pinovelToken.value = res.accessToken;
    localStorage.setItem('pinovel_token', res.accessToken);
    pinovelPassword.value = '';
    await loadNovelProjects();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pinovelLoading.value = false;
  }
}

function logoutPinovel() {
  pinovelToken.value = '';
  localStorage.removeItem('pinovel_token');
  novelProjects.value = [];
  novelChapters.value = [];
  selectedNovelProjectId.value = '';
  selectedChapterIds.value = new Set();
}

async function loadNovelProjects() {
  if (!pinovelToken.value) return;
  pinovelLoading.value = true;
  try {
    const res = await pinovelApi.listProjects(pinovelToken.value);
    novelProjects.value = res.items;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pinovelLoading.value = false;
  }
}

async function onNovelProjectChange() {
  novelChapters.value = [];
  selectedChapterIds.value = new Set();
  if (!selectedNovelProjectId.value || !pinovelToken.value) return;
  pinovelLoading.value = true;
  try {
    novelChapters.value = await pinovelApi.listChapters(
      pinovelToken.value,
      selectedNovelProjectId.value,
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pinovelLoading.value = false;
  }
}

function toggleChapter(chapterId: number) {
  const next = new Set(selectedChapterIds.value);
  if (next.has(chapterId)) {
    next.delete(chapterId);
  } else {
    next.add(chapterId);
  }
  selectedChapterIds.value = next;
}

async function createProject() {
  const selected = novelChapters.value
    .filter((c) => selectedChapterIds.value.has(c.id))
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
  const title = form.value.title.trim() || (selected.length > 0 ? selected[0].title : '');
  if (!title) {
    error.value = '请输入项目标题或选择章节';
    return;
  }
  const rawText =
    selected.length > 0 ? selected.map((c) => c.content).join('\n\n') : form.value.rawText;
  if (!rawText.trim()) {
    error.value = '请粘贴小说文本或从 PiNovelStudio 选择章节';
    return;
  }
  try {
    const project = await api.createProject({
      ...form.value,
      title,
      rawText,
      chapterIds: selected.map((c) => String(c.id)),
    });
    router.push(`/projects/${project.id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  loadProjects();
  if (pinovelToken.value) loadNovelProjects();
});
</script>

<template>
  <div class="page">
    <h1>PiVideoStudio</h1>
    <p class="sub">小说 → 分镜 → 视频片段 → 成片</p>

    <section class="create-form">
      <h2>创建项目</h2>
      <input v-model="form.title" placeholder="项目标题" class="input" />
      <div class="row">
        <select v-model="form.style" class="select">
          <option value="narration">推文风</option>
          <option value="motion-comic">动态漫</option>
          <option value="commentary">解说风</option>
        </select>
        <select v-model="form.aspectRatio" class="select">
          <option value="9:16">9:16 竖屏</option>
          <option value="16:9">16:9 横屏</option>
        </select>
      </div>
      <!-- 章节来源：从 PiNovelStudio 选择（B5） -->
      <div class="pinovel-section">
        <div class="pinovel-head">
          <h3>章节来源（可选）</h3>
          <span v-if="pinovelToken" class="pinovel-ok">已连接 PiNovelStudio</span>
        </div>
        <template v-if="!pinovelToken">
          <div class="row">
            <input v-model="pinovelEmail" placeholder="PiNovelStudio 邮箱" class="input" />
            <input
              v-model="pinovelPassword"
              type="password"
              placeholder="密码"
              class="input"
              @keyup.enter="loginPinovel"
            />
          </div>
          <button @click="loginPinovel" :disabled="pinovelLoading" class="btn small">
            {{ pinovelLoading ? '连接中...' : '连接 PiNovelStudio' }}
          </button>
        </template>
        <template v-else>
          <div class="row">
            <select v-model="selectedNovelProjectId" @change="onNovelProjectChange" class="select">
              <option value="" disabled>选择小说项目</option>
              <option v-for="np in novelProjects" :key="np.id" :value="String(np.id)">
                {{ np.title }}
              </option>
            </select>
            <button @click="logoutPinovel" class="btn small">断开</button>
          </div>
          <div v-if="novelChapters.length > 0" class="chapter-list">
            <label
              v-for="c in novelChapters"
              :key="c.id"
              :class="['chapter-item', { checked: selectedChapterIds.has(c.id) }]"
            >
              <input
                type="checkbox"
                :checked="selectedChapterIds.has(c.id)"
                @change="toggleChapter(c.id)"
              />
              <span class="ch-num">第{{ c.chapterNumber }}章</span>
              <span class="ch-title">{{ c.title }}</span>
              <span class="ch-words">{{ c.wordCount }} 字</span>
            </label>
          </div>
          <p v-else-if="selectedNovelProjectId" class="hint">
            {{ pinovelLoading ? '章节加载中...' : '该项目暂无章节' }}
          </p>
          <p v-if="selectedChapterIds.size > 0" class="hint">
            已选 {{ selectedChapterIds.size }} 章，创建时将自动拼接章节正文
          </p>
        </template>
      </div>
      <textarea
        v-model="form.rawText"
        placeholder="粘贴小说章节文本（或从上方 PiNovelStudio 选择章节）..."
        class="textarea"
        rows="8"
      ></textarea>
      <button @click="createProject" class="btn">创建项目</button>
    </section>

    <p v-if="error" class="error">{{ error }}</p>

    <section class="project-list">
      <h2>项目列表</h2>
      <p v-if="loading">加载中...</p>
      <div v-else-if="projects.length === 0" class="empty">暂无项目</div>
      <ul v-else>
        <li v-for="p in projects" :key="p.id" @click="router.push(`/projects/${p.id}`)">
          <strong>{{ p.title }}</strong>
          <span class="meta">{{ p.style }} · {{ p.aspectRatio }} · {{ p.status }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 800px;
  margin: 0 auto;
  padding: 40px 20px;
  font-family: system-ui, -apple-system, sans-serif;
}
.sub {
  color: #666;
  margin-bottom: 24px;
}
.create-form {
  margin-bottom: 32px;
  padding: 20px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
}
.create-form h2 {
  margin: 0 0 16px;
  font-size: 18px;
}
.input, .select, .textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  box-sizing: border-box;
  margin-bottom: 12px;
}
.textarea {
  resize: vertical;
  font-family: inherit;
}
.row {
  display: flex;
  gap: 12px;
}
.row .select {
  flex: 1;
}
.btn {
  padding: 10px 24px;
  background: #3b82f6;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}
.btn:hover {
  background: #2563eb;
}
.btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
.project-list ul {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 8px;
}
.project-list li {
  padding: 12px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.project-list li:hover {
  background: #f9fafb;
}
.meta {
  color: #6b7280;
  font-size: 13px;
}
.error {
  color: #ef4444;
  padding: 8px 0;
}
.empty {
  color: #9ca3af;
}
.pinovel-section {
  border: 1px dashed #d1d5db;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.pinovel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.pinovel-head h3 {
  margin: 0;
  font-size: 14px;
}
.pinovel-ok {
  color: #059669;
  font-size: 12px;
}
.chapter-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-top: 8px;
}
.chapter-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px dashed #f3f4f6;
}
.chapter-item:hover {
  background: #f9fafb;
}
.chapter-item.checked {
  background: #eff6ff;
}
.ch-num {
  color: #2563eb;
  white-space: nowrap;
}
.ch-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-words {
  color: #9ca3af;
  font-size: 12px;
  white-space: nowrap;
}
.hint {
  color: #6b7280;
  font-size: 12px;
  margin: 6px 0 0;
}
.btn.small {
  padding: 6px 14px;
  font-size: 13px;
}
</style>
