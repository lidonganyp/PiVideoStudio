/**
 * JWT 认证中间件（B7 融合：与 PiNovelStudio 共享登录态）。
 *
 * PiNovelStudio 登录后签发 HS256 JWT（payload: { sub, email, role, iat, exp }），
 * 前端存 localStorage['platform_token']。两个前端同域（ainovel.cloud），
 * PiVideoStudio 前端读取同一 key 携带 Authorization: Bearer <token>。
 *
 * 行为：
 *   - JWT_SECRET 未配置：放行（开发模式，req.user = undefined）
 *   - JWT_SECRET 已配置：所有 /api/* 请求必须携带有效 token，否则 401
 *   - 豁免路径：/health、/files/*、/api/pinovel/login（登录代理本身）
 */
import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthUser {
  sub: number;
  email: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** 豁免认证的路径前缀 */
const PUBLIC_PATHS = ['/health', '/api/health', '/files/', '/api/pinovel/login'];

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * 验证 HS256 JWT 签名与有效期，返回 payload 或 null。
 * 不依赖 jsonwebtoken 库：header.payload.signature 三段式手动验签。
 */
export function verifyJwt(token: string, secret: string): AuthUser | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  let payload: { sub?: number; email?: string; role?: string; exp?: number };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  if (typeof payload.sub !== 'number' || typeof payload.email !== 'string') return null;

  // 过期检查（exp 秒级时间戳）
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;

  // 签名验证（恒定时间比较）
  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  return {
    sub: payload.sub,
    email: payload.email,
    role: typeof payload.role === 'string' ? payload.role : 'user',
  };
}

/** Express 中间件：JWT 认证（JWT_SECRET 未配置时放行）。 */
export function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // 开发模式：未配置密钥不拦截
    next();
    return;
  }

  const path = req.path;
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const user = verifyJwt(auth.slice(7), secret);
    if (user) {
      req.user = user;
      next();
      return;
    }
  }
  res.status(401).json({ error: 'unauthorized: 请先登录 PiNovelStudio' });
}
