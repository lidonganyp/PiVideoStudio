# PiVideoStudio 项目概览

## 项目定位

小说转视频生成平台：将小说章节拆分为分镜，生成分镜提示词，调用视频生成 API 产出片段，配音字幕后合成为成片。pnpm monorepo 架构，与 PiNovelStudio 通过 B6 融合模块联动。

## 技术栈

- 运行时：Node.js >= 20.19，TypeScript ESM
- 包管理：pnpm 10.26.2 monorepo
- API：Express（端口 3100）
- 前端：Vue 3 + Vite + Element Plus（端口 5173）
- 数据库：SQLite（better-sqlite3）
- 视频合成：ffmpeg（worker 独立进程）
- 视频生成：Mock / Keling / Jimeng / MiniMax H3
- LLM：OpenAI 兼容接口
- 部署：Docker Compose / PM2

## 模块架构

- **runtime/**：编排核心，九阶段状态机、文本拆分、资产提取、提示词构建、供应商网关、TTS、计费、队列、数据存储
- **api/**：Express HTTP API，项目/分镜/任务管理，端口 3100
- **worker/**：ffmpeg 合成 worker，独立进程，拼接片段+字幕+配音
- **web/**：Vue 3 视频工作台，向导式 4 步工作流
- **docs/**：项目文档
- **scripts/**：运维脚本（存储清理）
- **storage/**：运行时存储（DB、日志、输出、视频）

## 九阶段流水线

0 任务创建 -> 1 文本拆分 -> 2 资产提取 -> 3 提示词生成 -> 4 参考图生成 -> 5 片段生成 -> 6 片段审核 -> 7 配音字幕 -> 8 ffmpeg 合成 -> 9 交付

审核不通过回流到阶段 5 重生成（版本化可回滚）。阶段 4 支持人工确认参考图，阶段 5 支持样片确认后批量生成。

## 主要 API 端点

- POST /api/projects — 创建视频项目（支持 novelContext）
- GET /api/projects/:id — 项目详情
- POST /api/projects/:id/split — 文本拆分
- POST /api/projects/:id/extract-assets — 资产提取
- POST /api/projects/:id/build-prompts — 提示词生成
- POST /api/projects/:id/generate-images — 参考图生成
- PUT /api/projects/:id/segments/:sid/select-image — 选择参考图
- POST /api/projects/:id/generate-sample — 生成样片
- POST /api/projects/:id/confirm-sample — 确认样片并批量生成
- POST /api/projects/:id/export — 导出片段包（ZIP）
- GET /health — 健康检查

## B6 融合：PiNovelStudio 联动

接收 PiNovelStudio 结构化上下文 novelContext：章节正文、大纲节点、人物卡、章节种子。创建项目时传入，runtime 自动注入上下文使分镜提示词更贴合叙事。

## 环境变量

- VIDEO_PROVIDER：视频供应商（mock/keling/jimeng/minimax），默认 mock
- MINIMAX_API_KEY：MiniMax API Key（mk- 开头）
- LLM_BASE_URL / LLM_API_KEY / LLM_MODEL：LLM 配置
- PIVIDEO_DB_PATH：SQLite 路径，默认 storage/pivideo.db
- PIVIDEO_API_URL：API 地址，默认 http://172.17.0.1:3100
- PIVIDEO_WEB_URL：Web 地址，默认 http://localhost:5173
- PORT：API 端口，默认 3100

## 部署

Docker Compose：docker compose up -d --build（三容器：api/worker/web）
PM2：pm2 start ecosystem.config.cjs

## 开发

pnpm install && pnpm dev:api && pnpm dev:web && pnpm dev:worker
