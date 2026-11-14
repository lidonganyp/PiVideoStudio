// ffmpeg 合成 worker 骨架：轮询任务队列，执行合成
// TODO: 接入真实队列（数据库轮询 / Redis），调用 ffmpeg 完成合成

const POLL_INTERVAL_MS = 3000;

async function pollOnce(): Promise<void> {
  // TODO: 拉取 compose 任务
  // TODO: ffmpeg 合成流水线：片段拼接 → 旁白音轨 → 背景音乐 ducking → 字幕烧录 → 封面截取
}

async function main(): Promise<void> {
  console.log('[pivideo-worker] started, polling interval:', POLL_INTERVAL_MS + 'ms');
  for (;;) {
    await pollOnce();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[pivideo-worker] fatal:', err);
  process.exit(1);
});
