# 与 PiNovelStudio 的融合契约（草案）

独立开发期间，主项目仅做一处改动：PortalLayout 导航新增『视频工场』入口，跳转 PiVideoStudio web 地址。

## 对接点

1. 入口跳转：主项目 web 导航 → PiVideoStudio web（开发期 http://localhost:5173，上线后正式域名）
2. 文本来源：阶段 1 文本拆分需要小说章节文本。MVP 阶段由用户粘贴；融合阶段改为调用 PiNovelStudio API 拉取章节
3. 鉴权：MVP 阶段无鉴权；融合阶段接入主项目会话
4. 计费：MVP 阶段不计费；融合阶段对接 budget ledger

## 融合检查清单

- [ ] VideoProvider 接口抽象完成，支持多供应商切换
- [ ] 分镜 / 资产 / 任务数据模型稳定（引入持久化存储）
- [ ] 主项目入口菜单上线
