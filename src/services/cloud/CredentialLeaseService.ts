/**
 * 官方凭据租约服务
 *
 * platform 型凭据（source='platform'）的值不落库，运行时向云端租约服务换取厂商临时 API Key：
 * - 本地内存缓存 {userId:provider → {apiKey, expiresAt}}，剩 <60s 自动续租
 * - 云端 POST /api/credentials/lease 用平台永久 AK/SK 调厂商控制面 API（如火山 GetApiKey）
 * - 直连流量走厂商官方端点，平台通过 usage 上报 + 日终对账计费（usage × 单价 × 加价率）
 *
 * LLM 零感知：凭据引用规则不变（credentialName=环境变量名），分流在解析点完成。
 */

import { CloudAuthService } from './CloudAuthService';

interface LeaseEntry {
  apiKey: string;
  expiresAt: number; // ms 时间戳
}

/** 剩余有效期低于该值时自动续租（比厂商 key 有效期短得多的安全余量） */
const LEASE_REFRESH_AHEAD_MS = 60_000;

/** 并发解析保护：同一 key 的请求只发一次 */
const pendingLease = new Map<string, Promise<string>>();

/** 本地租约缓存 */
const leaseCache = new Map<string, LeaseEntry>();

/**
 * 解析 platform 凭据的真实值（厂商临时 API Key，带缓存与自动续租）
 * @param userId 当前用户
 * @param provider 厂商标识（凭据条目的 provider 字段，如 volcengine-ark）
 */
export async function resolvePlatformCredential(userId: string, provider: string): Promise<string> {
  const cacheKey = `${userId}:${provider}`;

  const cached = leaseCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > LEASE_REFRESH_AHEAD_MS) {
    return cached.apiKey;
  }

  // 🔥 并发解析保护
  const inflight = pendingLease.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      // 🔥 cloudRequest 的 endpoint 不带 /api 前缀（CLOUD_API_BASE_URL 已含）
      const resp = await CloudAuthService.cloudRequest(
        '/credentials/lease',
        { method: 'POST', body: JSON.stringify({ provider }) },
        true
      );
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || !result?.success || !result?.apiKey) {
        throw new Error(result?.error || `租约服务响应异常(${resp.status})`);
      }
      const entry: LeaseEntry = {
        apiKey: String(result.apiKey),
        // 云端返回 ISO/秒时间戳，统一转 ms；缺失时按 10 分钟兜底
        expiresAt: result.expiresAt ? new Date(result.expiresAt).getTime() : Date.now() + 10 * 60_000,
      };
      leaseCache.set(cacheKey, entry);
      console.log(`🔑 [CRED-LEASE] 已获取 ${provider} 临时凭据，有效期至 ${new Date(entry.expiresAt).toISOString()}`);
      return entry.apiKey;
    } finally {
      pendingLease.delete(cacheKey);
    }
  })();

  pendingLease.set(cacheKey, task);
  return task;
}
