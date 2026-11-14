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

## 部署

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VIDEO_PROVIDER` | 视频生成供应商：mock / keling / jimeng | mock |
| `LLM_BASE_URL` | LLM API 地址 | - |
| `LLM_API_KEY` | LLM API Key | - |
| `LLM_MODEL` | LLM 模型名称 | - |
| `NOVEL_STUDIO_BASE_URL` | PiNovelStudio API 地址 | - |
| `NOVEL_STUDIO_TOKEN` | PiNovelStudio 访问令牌 | - |
| `PIVIDEO_DB_PATH` | SQLite 数据库路径 | storage/pivideo.db |
| `PIVIDEO_WEB_URL` | Web 前端地址（用于 Portal 跳转） | http://localhost:5173 |
| `PORT` | API 监听端口 | 3100 |

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
