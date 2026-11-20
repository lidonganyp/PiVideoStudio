# 融合架构（PiNovelStudio × PiVideoStudio）

> 一个产品、一个域名、一套账号、一份余额。两个子系统独立开发、独立部署，融合层只出现在用户看不见的接缝处。

## 总览

```
用户浏览器
  │
  ▼ https://ainovel.cloud (nginx, 443)
  ├── /                    → PiNovelStudio Web（小说，主入口）
  ├── /api/                → PiNovelStudio API（NestJS, :3000, docker）
  ├── /video/              → PiVideoStudio Web（Vue 3 + Vite, :5173）
  ├── /video/api/          → PiVideoStudio API（Express, :3100，去前缀转发）
  └── /video/files/        → PiVideoStudio 静态资源（:3100，去前缀转发）
```

- 5173 / 3100 / 3000 均只监听本机，公网仅 80/443 经 nginx 进入（3000 有历史防火墙放行，建议后续收紧）。
- 跳转链接由 `PIVIDEO_WEB_URL=https://ainovel.cloud/video` 生成，禁止硬编码 localhost。

## 共享登录态（JWT）

```
PiNovelStudio 登录 → 签发 HS256 JWT（sub/email/role, 7d）
  → localStorage['platform_token']（同域共享）
  → PiVideoStudio 前端读取同一 key，携带 Authorization: Bearer
  → PiVideoStudio API 用相同 JWT_SECRET 验签（api/src/auth.ts，零依赖手写实现）
```

- 豁免路径：`/health`、`/files/*`、`/api/pinovel/login`。
- 项目归属：`video_projects.owner_user_id`，创建时从 JWT 注入；列表按 owner 过滤，`/api/projects/:id*` 统一所有权校验（admin 放行，旧数据 owner 为 NULL 过渡期放行）。
- `JWT_SECRET` 未配置时 API 放行（开发模式），生产必须配置。

## 统一余额计费

复用 PiNovelStudio 的 hold / settle / finalize 三段式（`/internal/billing/*`，HMAC-SHA256 签名 + nonce 防重放）：

```
生成前   POST /internal/billing/holds            预占（余额不足 402 拒绝）
每分镜   POST /internal/billing/settlements      按秒结算（jobId+callId 幂等）
批次终态 POST /internal/billing/holds/:id/finalize  收尾（success→settled / failure→released 释放未结算部分）
```

- 客户端：`runtime/src/billing-client/index.ts`（签名算法与 platform hmac.ts 对齐：timestamp/nonce/METHOD/path/sha256(stableBody)）。
- 批次：`generate-segments` 创建 hold（估算 = 秒数×9分 + TTS×2分，上浮 20%），job 记 `billing_hold_id`；worker 在 job 成功时结算、批次全部终态时收尾。
- 幂等：settle 以 jobId+callId 去重，worker 重试不会重复扣费；hold 以 jobId 去重。
- 费率（model_rates 表）：`pivideo_minimax_h3` 视频 9 分/秒、`pivideo_minimax_h3_image` 参考图 5 分/次、`pivideo_minimax_tts` TTS 2 分/次。秒数→token 换算：tokensIn = 秒 × 1e6。

## 服务间调用关系

| 调用方 | 被调方 | 协议 | 用途 |
|---|---|---|---|
| PiNovelStudio API | PiVideoStudio API | HTTP（PIVIDEO_API_URL） | 章节页『生成视频』：聚合上下文创建视频项目 |
| PiVideoStudio API | PiNovelStudio API | HTTP + HMAC（PINOVEL_API_URL + INTERNAL_API_SECRET） | 计费 hold/settle/finalize |
| PiVideoStudio API | PiNovelStudio API | HTTP + Bearer（NOVEL_STUDIO_TOKEN） | 拉取小说项目/章节（B5 导入） |

## 环境变量

PiVideoStudio（.env）：

```
JWT_SECRET=<与 PiNovelStudio 相同>
PINOVEL_API_URL=http://172.17.0.1:3000
INTERNAL_API_SECRET=<与 PiNovelStudio 相同>
PIVIDEO_WEB_URL=https://ainovel.cloud/video
```

PiNovelStudio（platform/.env）：

```
PIVIDEO_API_URL=http://172.17.0.1:3100
PIVIDEO_WEB_URL=https://ainovel.cloud/video
```

## 验证记录（2026-11-19）

- JWT：无 token 401 / 伪造 token 401 / 合法 token 200 / owner 过滤生效。
- 计费：hold 1 分 → settle（幂等 alreadySettled=true）→ finalize settled，全链路通过。
- 入口：`/video/`、`/video/api/projects`、`/video/projects/:id` 均 200。
