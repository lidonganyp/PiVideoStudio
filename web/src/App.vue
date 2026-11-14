<script setup lang="ts">
const stages = [
  { id: 0, name: '任务创建', desc: '选择小说章节、风格模板与画幅' },
  { id: 1, name: '文本拆分', desc: '章节切分为分镜，预估时长' },
  { id: 2, name: '资产提取', desc: '角色卡与场景卡入库' },
  { id: 3, name: '提示词生成', desc: '分镜生成结构化提示词包' },
  { id: 4, name: '参考图生成', desc: '角色定妆照与场景底图' },
  { id: 5, name: '片段生成', desc: '调用视频 API，异步任务轮询' },
  { id: 6, name: '片段审核', desc: '时间轴预览，单片段重生成' },
  { id: 7, name: '配音字幕', desc: 'TTS 旁白 + SRT 字幕' },
  { id: 8, name: 'ffmpeg 合成', desc: '拼接 + 音轨 + 字幕烧录' },
  { id: 9, name: '交付', desc: '成片存储与在线播放' },
];
</script>

<template>
  <main class="page">
    <h1>PiVideoStudio</h1>
    <p class="sub">小说 → 分镜 → 视频片段 → 成片</p>
    <ol class="stages">
      <li v-for="s in stages" :key="s.id">
        <strong>{{ s.id }}. {{ s.name }}</strong>
        <span>{{ s.desc }}</span>
      </li>
    </ol>
  </main>
</template>

<style>
.page {
  max-width: 720px;
  margin: 0 auto;
  padding: 40px 20px;
  font-family: system-ui, -apple-system, sans-serif;
}
.sub {
  color: #666;
}
.stages {
  display: grid;
  gap: 8px;
  padding: 0;
  list-style: none;
}
.stages li {
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.stages span {
  color: #666;
  font-size: 14px;
}
</style>
