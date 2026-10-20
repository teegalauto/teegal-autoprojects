/**
 * 官方 hosted 通道客户端（webshell 统一出口）
 *
 * 搜索与网页爬取统一走 homeweb /api/search-proxy，本地无需配置任何搜索源 Key。
 * 鉴权与 RentalProxy 同模型：取当前登录用户 JWT，401 自愈续期重试一次。
 */

import { userModelRegistry } from '../utils/llm/UserModelRegistry';
import { isCloudProxyUrl, refreshPackageToken } from '../utils/llm/CloudTokenRefresher';

export const HOSTED_BASE = (process.env.HOME_WEB_URL || 'https://www.workbees.space').replace(/\/$/, '');

export interface HostedJwt {
  accessToken: string;
  refreshToken?: string;
}

/** 获取当前登录用户的云端 JWT（未登录返回 null） */
export function getHostedJwt(): HostedJwt | null {
  const userId = userModelRegistry.getCurrentUserId();
  if (!userId) return null;
  for (const model of userModelRegistry.getAllUserModels(userId)) {
    if (isCloudProxyUrl(model.url) && model.apiKey) {
      return { accessToken: model.apiKey, refreshToken: model.refreshToken };
    }
  }
  return null;
}

/** 调用官方 /api/search-proxy（401 自动续期重试一次） */
export async function hostedSearchProxy<T = any>(body: Record<string, unknown>, retried = false): Promise<T> {
  const jwt = getHostedJwt();
  if (!jwt?.accessToken) {
    throw new Error('未登录，官方搜索通道不可用');
  }

  const resp = await fetch(`${HOSTED_BASE}/api/search-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const data: any = await resp.json().catch(() => null);
  if (!resp.ok) {
    // 用户 JWT 过期 → 401 自愈续期重试一次（与 llmProxy/rental 同链路）
    if (resp.status === 401 && !retried && jwt.refreshToken) {
      const tokens = await refreshPackageToken({
        url: `${HOSTED_BASE}/api/llm-proxy/call`,
        refreshToken: jwt.refreshToken,
      });
      if (tokens?.accessToken) {
        return hostedSearchProxy<T>(body, true);
      }
    }
    throw new Error(data?.error || `官方搜索通道 HTTP ${resp.status}`);
  }
  return data as T;
}

/** 官方通道网页爬取（服务端 firecrawl） */
export async function hostedFetch(url: string): Promise<{ content: string; metadata: any }> {
  const data: any = await hostedSearchProxy({ action: 'fetch', url });
  return { content: data?.content || '', metadata: data?.metadata || {} };
}
