/** 加载项目根目录 .env（Node 22 内置 loadEnvFile，文件不存在时忽略） */
try {
  process.loadEnvFile();
} catch {
  // .env 不存在时忽略（如 CI 环境）
}

