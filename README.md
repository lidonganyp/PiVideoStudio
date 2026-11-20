# PiVideoStudio

小说转视频生成平台：将小说章节拆分为分镜，生成分镜提示词，调用视频生成 API 产出片段，配音字幕后合成为成片。

**与 PiNovelStudio（小说生成平台）同属一个产品**：统一域名 `ainovel.cloud`，小说侧在章节页点击『生成视频』即可跳转本工场（`/video/` 子路径）。

## 融合体系（B6 + B7）

| 能力 | 说明 |
|---|---|
| 统一入口 | nginx 将 `https://ainovel.cloud/video/` 反代到本工场（Web 5173 / API 3100），与小说侧共用域名与证书 |
| 共享登录态（JWT） | 复用 PiNovelStudio 签发的 HS256 JWT（`localStorage['platform_token']`），`JWT_SECRET` 一致即互通；API 侧强制认证，项目按 `owner_user_id` 隔离 |
| 统一余额计费 | 生成前经 HMAC 内部 API 向 PiNovelStudio 预占（hold）→ 每个分镜成功后按秒结算（settle，jobId+callId 幂等）→ 批次终态后收尾（finalize，失败释放） |
| 计费费率 | `model_rates` 表：`pivideo_minimax_h3`（视频 9 分/秒）、`pivideo_minimax_h3_image`（参考图 5 分/次）、`pivideo_minimax_tts`（TTS 2 分/次） |

> 详细项目介绍见 [docs/project-overview.md](docs/project-overview.md)，融合契约见 [docs/integration-contract.md](docs/integration-contract.md)，整体架构见 [docs/fusion-architecture.md](docs/fusion-architecture.md)。

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

## 部署

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VIDEO_PROVIDER` | 视频生成供应商：mock / minimax / seedance | mock |
| `IMAGE_PROVIDER` | 图片生成供应商：mock / minimax / openai | mock |
| `MINIMAX_API_KEY` | MiniMax API Key（mk- 开头） | - |
| `MINIMAX_BASE_URL` | MiniMax API 地址 | https://metaso.cn/api/minimax |
| `MINIMAX_MODEL` | MiniMax 视频模型名 | MiniMax-H3 |
| `MINIMAX_IMAGE_MODEL` | MiniMax 图片模型名 | MiniMax-H3-Image |
| `OPENAI_IMAGE_BASE_URL` | OpenAI 兼容图片 API 地址 | https://aimagichub.xyz/v1 |
| `OPENAI_IMAGE_MODEL` | OpenAI 图片模型名 | gpt-image-2 |
| `OPENAI_IMAGE_API_KEY` | OpenAI 图片 API Key（未设置时回退 LLM_API_KEY） | - |
| `LLM_BASE_URL` | LLM API 地址 | - |
| `LLM_API_KEY` | LLM API Key | - |
| `LLM_MODEL` | LLM 模型名称 | - |
| `NOVEL_STUDIO_BASE_URL` | PiNovelStudio API 地址 | - |
| `NOVEL_STUDIO_TOKEN` | PiNovelStudio 访问令牌 | - |
| `PIVIDEO_DB_PATH` | SQLite 数据库路径 | storage/pivideo.db |
| `PIVIDEO_WEB_URL` | Web 前端地址（用于 Portal 跳转） | http://localhost:5173 |
| `PORT` | API 监听端口 | 3100 |
| `GENERATE_CONCURRENCY` | 分镜生成并发数 | 3 |
| `JWT_SECRET` | JWT 签名密钥（与 PiNovelStudio 共享） | - |
| `PINOVEL_API_URL` | PiNovelStudio 内部计费 API 地址 | - |
| `INTERNAL_API_SECRET` | 内部 API HMAC 密钥 | - |
| `ENABLE_FIRST_FRAME_CHAIN` | 首帧链（上一块尾帧作下一块首帧参考） | false |
| `ENABLE_AUTO_QC` | 自动 QC 三级分流 | false |
| `AUDIO_STRATEGY` | 音频策略：hybrid / uniform | hybrid |
| `SUBTITLE_BURN` | 字幕烧录：off / on | off |

### Docker 部署

```bash
# 构建并启动全部服务
 docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

Docker Compose 编排三个容器：

- **pivideo-api**：HTTP API 服务，端口 3100
- **pivideo-worker**：ffmpeg 合成 worker 进程
- **pivideo-web**：Web 前端，端口 5173

镜像基于 `node:22-alpine`，内置 ffmpeg，采用多阶段构建减小体积。存储目录通过 volume 挂载持久化。

### PM2 部署

```bash
# 安装 PM2
npm install -g pm2

# 启动全部进程
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status

# 查看日志
pm2 logs

# 停止
pm2 stop all
```

PM2 配置三个进程：

- **pivideo-api**：API 服务，端口 3100
- **pivideo-worker**：合成 worker
- **pivideo-web**：Web 前端，端口 5173

### 健康检查

API 提供 `/api/health` 端点（免认证），返回服务状态和运行时间：

```bash
curl http://localhost:3100/api/health
# {"status":"ok","uptime":123.45}
```

### 数据库备份

SQLite 数据库每天自动备份（crontab 3:00），保留最近 7 天：

```bash
# 手动备份
./scripts/backup-db.sh

# 查看备份
ls -la storage/backups/
```

### 存储清理

定期清理临时素材文件，保留数据库和近期文件：

```bash
# 预览（不实际删除）
./scripts/cleanup-storage.sh --dry-run

# 清理 7 天以上的文件和超过 10G 的大文件
./scripts/cleanup-storage.sh

# 自定义参数
./scripts/cleanup-storage.sh --max-age 3 --max-size 5G
```

建议配合 crontab 定时执行：

```bash
# 每天凌晨 3 点清理
0 3 * * * /root/PiVideoStudio/scripts/cleanup-storage.sh >> /var/log/pivideo-cleanup.log 2>&1
```

### 图片供应商选择

| 供应商 | IMAGE_PROVIDER | 说明 |
|---|---|---|
| Mock | `mock` | 占位图，开发用 |
| MiniMax | `minimax` | metaso.cn 代理，免费试用有限 |
| OpenAI | `openai` | aimagichub.xyz 收费接口，复用 LLM_API_KEY，模型 gpt-image-2 |

MiniMax 免费试用用完后切换到 OpenAI：

```bash
# .env 中修改
IMAGE_PROVIDER=openai
OPENAI_IMAGE_BASE_URL=https://aimagichub.xyz/v1
OPENAI_IMAGE_MODEL=gpt-image-2
# API Key 自动回退到 LLM_API_KEY
```
