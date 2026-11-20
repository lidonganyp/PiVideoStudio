/**
 * PM2 进程管理配置。
 * 启动：pm2 start ecosystem.config.cjs
 * 重启：pm2 restart pivideo
 * 停止：pm2 stop pivideo
 * 日志：pm2 logs pivideo
 */
module.exports = {
  apps: [
    {
      name: 'pivideo-api',
      script: 'api/node_modules/tsx/dist/cli.mjs',
      args: 'api/src/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '3100',
      },
      max_memory_restart: '512M',
      max_restarts: 10,
      restart_time: 60000,
      log_file: 'storage/logs/api.log',
      error_file: 'storage/logs/api-error.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: 'pivideo-worker',
      script: 'worker/node_modules/tsx/dist/cli.mjs',
      args: 'worker/src/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
      max_restarts: 10,
      restart_time: 60000,
      log_file: 'storage/logs/worker.log',
      error_file: 'storage/logs/worker-error.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: 'pivideo-web',
      script: 'node_modules/vite/bin/vite.js',
      args: 'preview --port 5173 --host',
      cwd: __dirname + '/web',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '256M',
      log_file: __dirname + '/storage/logs/web.log',
      error_file: __dirname + '/storage/logs/web-error.log',
      merge_logs: true,
      autorestart: true,
    },
  ],
};
