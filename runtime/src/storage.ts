import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根目录 storage 的绝对路径。
 * api / worker / runtime 共用，避免依赖各进程的 cwd（pnpm --filter 下为子包目录）。
 */
export const STORAGE_DIR = resolve(
  fileURLToPath(new URL('../../storage', import.meta.url)),
);
