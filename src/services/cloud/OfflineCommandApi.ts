/**
 * OfflineCommandApi - 离线指挥云端配置接口（JWT 鉴权，本地设置面板用）
 *
 * 通道数据面（poll/ack/complete）用通道 token，见 offlineChannel.ts；
 * 此处只管配置面：启用分配地址、白名单、token 重置、停用。
 */

import { CLOUD_BASE_URL } from '@/config/api';
import { getAuthToken } from './CloudApiClient';

export interface OfflineConfig {
  addr: string;
  token: string;
  whitelist: string[];
  mailDomain?: string;
}

async function request<T>(endpoint: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<T> {
  const token = getAuthToken();
  if (!token) throw new Error('未登录');
  const res = await fetch(`${CLOUD_BASE_URL}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `请求失败 [${res.status}]`);
  }
  return data as T;
}

export const OfflineCommandApi = {
  /** 启用/重新启用：分配指令地址（幂等） */
  register: () => request<{ success: boolean; addr: string; token: string; whitelist: string[]; mailDomain: string }>('/api/offline/register', 'POST'),

  /** 查询配置 */
  getConfig: () => request<{
    success: boolean; configured: boolean; enabled: boolean; addr?: string; token?: string;
    whitelist?: string[]; status?: string; runStartedAt?: number | null; pendingSince?: number | null;
    todayCount?: number; mailDomain?: string;
  }>('/api/offline/config'),

  /** 白名单全量替换 */
  setWhitelist: (whitelist: string[]) => request<{ success: boolean; whitelist: string[] }>('/api/offline/whitelist', 'POST', { whitelist }),

  /** 重置通道 token（旧 token 立即失效） */
  resetToken: () => request<{ success: boolean; token: string }>('/api/offline/reset-token', 'POST'),

  /** 停用（保留地址与白名单） */
  disable: () => request<{ success: boolean }>('/api/offline/disable', 'POST'),
};
