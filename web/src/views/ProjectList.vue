<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, type Project } from '../api';

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

async function createProject() {
  if (!form.value.title.trim()) {
    error.value = '请输入项目标题';
    return;
  }
  try {
    const project = await api.createProject(form.value);
    router.push(`/projects/${project.id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(loadProjects);
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
      <textarea
        v-model="form.rawText"
        placeholder="粘贴小说章节文本..."
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
</style>
