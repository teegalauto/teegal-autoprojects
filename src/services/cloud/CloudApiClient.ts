/**
 * Home Web API Client
 * 专门用于与 home-web 后端通信
 * 与 local-backend 的 ApiClient 分离
 */

import { CLOUD_BASE_URL } from '@/config/api';
const HOME_WEB_URL = CLOUD_BASE_URL;

// 🔥 获取认证 Token
const getAuthToken = (): string | null => {
  try {
    const token = localStorage.getItem('cloud_access_token');
    return token || null;
  } catch (e) {
    console.error('[CloudApiClient] 获取 Token 失败:', e);
  }
  return null;
};

// 🔥 获取当前用户 ID
const getCurrentUserId = (): string | null => {
  try {
    const userStr = localStorage.getItem('teegal-user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.id?.toString() || null;
    }
  } catch (e) {
    console.error('[CloudApiClient] 获取用户 ID 失败:', e);
  }
  return null;
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const url = `${HOME_WEB_URL}${endpoint}`;
  const token = getAuthToken();

  const { method = 'GET', body, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 调用失败 [${response.status}]: ${errorText}`);
  }

  return response.json();
}

/**
 * App 市场 API
 */
export const AppMarketApi = {
  shareApp: (body: {
    appId: string;
    appName: string;
    appCode: string;
    targetEmail: string;
    definition?: string; // 🔥 数据库依赖定义
  }) => request<{ success: boolean; shareId: string; marketAppId: string; message: string }>('/api/app-market/share', {
    method: 'POST',
    body,
  }),

  publishApp: (body: {
    appId: string;
    appName: string;
    appCode: string;
    description: string;
    definition: string;
    interfaceSpec: string;
    pricePerCall: number;
  }) => request<{ success: boolean; marketAppId: string; message: string }>('/api/app-market/publish', {
    method: 'POST',
    body,
  }),

  getPendingShares: () => request<{ success: boolean; shares: any[] }>('/api/app-market/pending-shares'),

  acceptShare: (body: { shareId: string; localAppId: string }) =>
    request<{ success: boolean; message: string }>('/api/app-market/accept-share', {
      method: 'POST',
      body,
    }),

  rejectShare: (body: { shareId: string }) =>
    request<{ success: boolean; message: string }>('/api/app-market/reject-share', {
      method: 'POST',
      body,
    }),
};

/**
 * 用户 API
 */
export const UserApi = {
  getProfile: () => request<{ success: boolean; user: any }>('/api/auth/profile'),
  getBalance: () => request<{ success: boolean; balance: number }>('/api/balance'),
};

/**
 * 轨迹上报 API：用户点"上报"把本回合完整轨迹发到 homeweb 存查（服务端保留 7 天）。
 * userId/email 服务端从 Bearer token 解，body 只带业务字段。
 */
export const TraceReportApi = {
  report: (body: { conversationId: string; trace: string }) =>
    request<{ success: boolean }>('/api/trace-report', { method: 'POST', body }),
};

export { getAuthToken, getCurrentUserId };
