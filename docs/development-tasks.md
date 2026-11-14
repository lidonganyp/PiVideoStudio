# PiVideoStudio 开发任务书

> 版本：v1.0（2026-11-14）
> 执行方式：本文件供 AI 按任务编号顺序执行。每个任务包含【目标】【涉及模块/文件】【实现要点】【验收标准】【依赖】。
> 全局约束见文末『执行约束』，所有任务必须遵守。

---

## 0. 背景与总体架构

PiVideoStudio 是小说转视频生成平台，独立于 PiNovelStudio 开发，主项目仅保留跳转入口，融合契约见 `docs/integration-contract.md`。

流水线九阶段：

```
0 任务创建 → 1 文本拆分 → 2 资产提取 → 3 提示词生成 → 4 参考图生成
→ 5 片段生成 → 6 片段审核 → 7 配音字幕 → 8 ffmpeg 合成 → 9 交付
                 ↑___________ 片段不满意回流重生成 ___________↑
```

模块划分：

| 模块 | 路径 | 职责 |
|---|---|---|
| runtime | `runtime/` | 编排核心：领域模型、状态机、splitter / asset-extractor / prompt-builder / provider-gateway / composer |
| api | `api/` | HTTP API（Express，端口 3100） |
| worker | `worker/` | ffmpeg 合成 worker（独立进程，队列驱动） |
| web | `web/` | 视频工作台前端（Vue 3 + Vite，端口 5173） |

---

## 1. 里程碑总览

| 里程碑 | 目标 | 包含任务 |
|---|---|---|
| P0 骨架链路 | 单章文本 → 自动分镜 → 单家 API 出片 → ffmpeg 合成 → 可下载成片 | T-01 ~ T-09 |
| P1 质量层 | 角色一致性、人工审核回流、配音字幕、单片段重生成 | T-10 ~ T-15 |
| P2 产品化 | 持久化、批量、多供应商路由、与主项目对接 | T-16 ~ T-20 |

---

## 2. P0 任务明细（骨架链路）

### T-01 持久化层与数据表

- **目标**：将 api 中的内存存储替换为 SQLite（better-sqlite3），建立核心表
- **涉及模块**：新建 `runtime/src/store/`（数据库访问层）、`api/src/`
- **数据表**：
  - `video_projects`：id, title, novel_source(json), style, aspect_ratio, status, created_at, updated_at
  - `video_segments`：id, project_id, seq_order, source_text, scene_summary, character_names(json), emotion, estimated_seconds, status, current_version
  - `video_segment_versions`：id, segment_id, version, prompt_bundle(json), video_path, audio_path, created_at
  - `video_assets`：id, project_id, kind(character/scene), name, description, reference_image_path
  - `video_jobs`：id, project_id, segment_id, kind(t2i/i2v/t2v/tts/compose), provider, provider_job_id, status, retry_count, result_path, error, created_at, updated_at
- **实现要点**：数据库文件放 `storage/pivideo.db`（已被 .gitignore 排除）；提供 `migrate()` 函数在服务启动时自动建表；所有写操作带 updated_at 维护
- **验收标准**：`pnpm dev:api` 启动后 `storage/pivideo.db` 自动创建；重启服务后 POST 创建的项目仍能 GET 到
- **依赖**：无

### T-02 LLM 网关（runtime/llm-gateway）

- **目标**：封装统一的 LLM 调用接口，供 splitter / asset-extractor / prompt-builder 复用
- **涉及模块**：新建 `runtime/src/llm/`
- **实现要点**：
  - 接口 `callLLM({ system, user, responseFormat: 'json' | 'text', temperature? }): Promise<string>`
  - 配置从环境变量读取：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`（提供 `.env.example`）
  - JSON 模式：解析失败自动重试 1 次（在 prompt 中追加格式修正指令），仍失败则抛错
  - 记录每次调用的 token 用量到日志（为后续计费预留）
- **验收标准**：用真实配置调用一次返回合法响应；故意返回非法 JSON 时能重试并最终报错
- **依赖**：T-01

### T-03 文本拆分器（runtime/splitter）

- **目标**：实现阶段 1——将章节文本拆分为分镜列表
- **涉及模块**：新建 `runtime/src/splitter/`，api 新增 `POST /api/projects/:id/split`
- **实现要点**：
  - 输入：项目 ID（从 novel_source.rawText 取文本）
  - LLM prompt 要求输出 JSON 数组，每项含：sourceText（原文切片）、sceneSummary、characterNames、emotion、estimatedSeconds（按旁白语速 4~5 字/秒估算）
  - 拆分规则：一个分镜对应一个连续镜头，3~10 秒（约 15~50 字旁白）；场景切换必须切分；2000 字章节拆 8~15 个分镜
  - 结果写入 video_segments，项目状态 planning → splitting → 完成后回到可审阅状态
- **验收标准**：提供一段 1500 字以上小说文本调用接口，返回 8 个以上结构化分镜且字段齐全，原文拼接后能还原全文（允许标点差异）
- **依赖**：T-02

### T-04 提示词构建器（runtime/prompt-builder）

- **目标**：实现阶段 3——为每个分镜生成结构化提示词包
- **涉及模块**：新建 `runtime/src/prompt-builder/`，api 新增 `POST /api/projects/:id/build-prompts`
- **实现要点**：
  - 输出 PromptBundle（类型已在 types.ts 定义）：camera（镜头语言）、visual（英文画面 prompt）、negative、narration（旁白）、subtitle
  - visual 生成规则：英文、包含风格后缀（按项目 style 模板选择）、人物分镜必须包含角色外貌锚点（P0 阶段先从原文提取，P1 阶段改为读资产卡）
  - 提示词模板抽为独立文件（如 `runtime/src/prompt-builder/templates/*.md`），便于迭代
  - 写回 video_segments.prompt_bundle 存当前版本
- **验收标准**：对 T-03 的分镜批量生成，每条 visual 为英文且包含风格后缀；分镜状态 draft → prompt_ready
- **依赖**：T-03

### T-05 视频 Provider 网关（runtime/provider-gateway）

- **目标**：实现阶段 5 的基础设施——抽象视频生成供应商接口，接入第一家供应商
- **涉及模块**：新建 `runtime/src/providers/`
- **实现要点**：
  - 定义接口 `VideoProvider`：`submit(job): Promise<{ providerJobId }>`、`query(providerJobId): Promise<{ status, videoUrl? }>`
  - P0 接入一家 API 型供应商（可灵/即梦/Vidu 任选其一，按已购买的账号来；配置走环境变量）
  - 同时实现 `MockProvider`：直接返回占位视频 URL（可用 https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4 之类公开测试素材），用于无 API 额度时的全链路联调
  - provider 选择由环境变量 `VIDEO_PROVIDER=mock|keling|...` 控制
- **验收标准**：MockProvider 下可完成 submit + query 全流程；真实 provider 至少 submit 成功返回 providerJobId
- **依赖**：T-01

### T-06 片段生成任务调度

- **目标**：实现阶段 5——分镜批量提交生成 + 异步轮询 + 失败重试
- **涉及模块**：api 新增 `POST /api/projects/:id/generate-segments`、`GET /api/projects/:id/jobs`；worker 中实现轮询循环
- **实现要点**：
  - 提交：为每个 prompt_ready 分镜创建 video_jobs 记录并调用 provider.submit，并发上限 3（配置化）
  - 轮询：worker 每 10 秒扫描 submitted 状态任务调用 provider.query；成功后下载视频到 `storage/videos/{segmentId}/v{version}.mp4`，分镜状态 → succeeded
  - 失败：retry_count < 3 自动重新提交，否则标记 failed 并记录 error
  - 分镜状态机流转必须使用 runtime/src/state-machine.ts 中的 SEGMENT_TRANSITIONS 校验
- **验收标准**：MockProvider 下 8 个分镜全部到达 succeeded 且本地有视频文件；手动把一个 provider 任务置失败能观察到自动重试
- **依赖**：T-04、T-05

### T-07 ffmpeg 合成器（worker/composer）

- **目标**：实现阶段 8——拼接成片
- **涉及模块**：worker 新建 `worker/src/composer.ts`；前置条件：服务器安装 ffmpeg（`yum install -y ffmpeg` 或静态构建版，安装后加入 README）
- **实现要点**：
  - P0 最小实现：按分镜顺序 concat 拼接（ffmpeg concat demuxer，统一转码到 1080x1920 或 1920x1080、30fps、yuv420p，保证片段参数一致再拼）
  - 触发：api 新增 `POST /api/projects/:id/compose`，校验全部分镜 succeeded 后创建 compose 任务
  - 输出：`storage/output/{projectId}/final.mp4` + `ffprobe` 校验时长 = 各片段之和（误差 < 1s）
- **验收标准**：MockProvider 全链路跑通后生成 final.mp4，ffprobe 可读取，时长正确，播放器可打开
- **依赖**：T-06

### T-08 交付接口

- **目标**：实现阶段 9——成片可预览下载
- **实现要点**：
  - api 新增静态路由 `/files/`，映射 storage 目录（注意路径穿越防护）
  - 项目状态 composing → delivering → done
  - `GET /api/projects/:id` 返回中包含 finalVideoUrl
- **验收标准**：compose 完成后通过 `http://localhost:3100/files/output/{id}/final.mp4` 可直接播放
- **依赖**：T-07

### T-09 web 最小工作台

- **目标**：P0 可用的操作界面，串联全流程
- **涉及模块**：web/
- **页面**：
  1. 项目列表页：创建项目（粘贴小说文本、选风格/画幅）、查看状态
  2. 项目详情页：分镜列表（原文+状态+视频预览）、操作按钮按当前阶段显示（拆分 → 生成提示词 → 生成片段 → 合成）、成片播放器
- **验收标准**：不调用任何命令行，纯页面操作完成一次 MockProvider 全链路出片
- **依赖**：T-08

---

## 3. P1 任务明细（质量层）

### T-10 资产提取器（阶段 2）
- 新建 `runtime/src/asset-extractor/`：从章节文本提取角色卡（外貌/服装/气质）与场景卡（地点/光线/道具），写入 video_assets
- api：`POST /api/projects/:id/extract-assets`、`GET /api/projects/:id/assets`
- 验收：同一角色跨分镜描述一致（从卡片取值而非每次即兴生成）
- 依赖：T-03

### T-11 参考图生成 + 图生视频（阶段 4）
- provider-gateway 扩展 ImageProvider 接口（t2i）；为每张资产卡生成 4 张候选参考图，web 端人工选 1 张入库
- VideoProvider 扩展 i2v 模式：人物分镜以角色参考图为首帧生成
- 验收：同一角色的两个分镜片段中人物形象肉眼可辨为同一人
- 依赖：T-10、T-05

### T-12 片段审核与单片段重生成（阶段 6）
- web 时间轴视图：逐片段预览，approve / reject + 编辑 prompt 重生成
- 重生成走版本化：video_segment_versions 新增版本，旧版本文件保留可回滚
- 门禁：全部 approved 才允许 compose
- 验收：reject 一个片段、改 prompt 重生成、时间轴显示新版本，且可切回旧版本
- 依赖：T-06、T-09

### T-13 配音与字幕（阶段 7）
- TTS 接入（edge-tts 或 GPT-SoVITS，配置化）：按分镜 narration 生成音频到 `storage/audio/`
- 音频驱动时间轴：用 ffprobe 取每条音频实际时长反写时间轴
- 生成整片 SRT 字幕
- 验收：成片带旁白且音画同步（口播结束时长大于画面时切换下一段）
- 依赖：T-06

### T-14 合成器完整版
- composer 升级：转场（淡入淡出）、旁白音轨、背景音乐 ducking、字幕烧录（硬字幕，支持样式配置）、封面截取
- 验收：成片包含全部音轨与字幕，ffprobe 验证双流（视频+音频）
- 依赖：T-13

### T-15 风格模板库
- narration（推文风）/ motion-comic（动态漫）/ commentary（解说风）三套模板：提示词后缀、转场、字幕样式、配乐基调
- 验收：同一文本用两套模板出片，画面风格与节奏明显不同
- 依赖：T-14

---

## 4. P2 任务明细（产品化）

### T-16 多供应商路由
- 失败自动切换备用 provider；按片段类型（有人物/纯场景）路由不同 provider
- 依赖：T-05

### T-17 批量与并发治理
- 多项目队列、每项目并发上限、全局 provider QPS 限制
- 依赖：T-06

### T-18 成本核算接入
- 每片段记录 provider 计费单元（秒数/次数），项目级成本汇总页；融合期对接 PiNovelStudio budget ledger
- 依赖：T-17

### T-19 与 PiNovelStudio 对接
- 主项目 PortalLayout 增加『视频工场』入口
- 文本来源改为调用主项目 API 拉取章节（替换粘贴模式）
- 鉴权打通（会话共享或 token 透传）
- 依赖：T-09、主项目侧排期

### T-20 部署与运维
- 生产部署：api/web/worker 三进程 pm2 或 docker compose；存储目录挂载与大文件清理策略；ffmpeg 静态构建打包
- 依赖：T-14

---

## 5. 执行约束（所有任务必须遵守）

1. **不碰主项目**：除 T-19 外，禁止修改 /root/PiNovelStudio 下任何文件
2. **类型安全**：每个任务完成后 `pnpm -r typecheck` 必须全绿
3. **状态机约束**：所有状态流转必须经过 runtime/src/state-machine.ts 校验，禁止直接写状态字段
4. **存储规范**：业务文件一律写入 `storage/` 子目录，数据库表字段变更必须同步更新本文件 T-01 的表结构说明
5. **提交规范**：每个任务一个 commit，信息格式 `feat(T-xx): 描述` 或 `fix(T-xx): 描述`，推送到 origin main
6. **验收留痕**：每个任务完成后在本文档对应任务下追加一节『验收记录』，写明验证命令与结果
7. **密钥安全**：API Key 只放 .env，禁止提交；.env.example 只留键名
