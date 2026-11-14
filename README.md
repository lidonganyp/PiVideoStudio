# PiVideoStudio

小说转视频生成平台：将小说章节拆分为分镜，生成分镜提示词，调用视频生成 API 产出片段，配音字幕后合成为成片。

与 PiNovelStudio（小说生成平台）独立开发，主项目仅保留跳转入口；融合契约见 docs/integration-contract.md。

## 架构

| 模块 | 职责 |
|---|---|
| runtime/ | 编排核心：领域模型、九阶段状态机、splitter / asset-extractor / prompt-builder / provider-gateway / composer |
| api/ | HTTP API：项目、分镜、任务管理（Express） |
| worker/ | ffmpeg 合成 worker（独立进程） |
| web/ | 视频工作台前端（Vue 3 + Vite） |

## 九阶段流水线

0 任务创建 → 1 文本拆分 → 2 资产提取 → 3 提示词生成 → 4 参考图生成 → 5 片段生成 → 6 片段审核 → 7 配音字幕 → 8 ffmpeg 合成 → 9 交付

审核不通过的片段回流到阶段 5 单独重生成（版本化，可回滚）。

## 开发

pnpm install
pnpm dev:api     # http://localhost:3100
pnpm dev:web     # http://localhost:5173
pnpm dev:worker
