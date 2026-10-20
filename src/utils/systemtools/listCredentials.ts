/**
 * List Credentials Tool (list_credentials)
 *
 * 🔥 凭据查询 + 参数写入工具（action 区分）：
 * - list（默认）：返回凭据与参数列表。env 型凭据只暴露名称（明文永不出库），param 型参数额外暴露值
 * - set：更新已有 param 型参数的值（不新建、不动 env 凭据）；updateSourceUrl 会同步 autoUpdater
 *
 * 闭环设计：
 * - LLM 通过 list 看到环境变量名（如 OPENAI_API_KEY）和描述
 * - LLM 在调用 userpc_shell 时传入 credentialName=环境变量名
 * - userpc_shell 自动注入为同名环境变量
 * - LLM 始终看不到凭据的明文值
 */

import { AutoStep, AutoToolResult } from '../auto/types';

interface ListCredentialsContext {
  userId: string;
  conversationId: string;
}

// 🔥 数值参数的范围约束（与凭据管理 UI 的 PARAM_RANGES 保持一致）
const PARAM_RANGES: Record<string, { min: number; max: number }> = {
  contextHistoryRounds: { min: 5, max: 30 },
  clearWindow: { min: 3, max: 15 },
  maxHistoryChars: { min: 20000, max: 200000 },
};

/**
 * 🔥 执行 list_credentials 工具
 */
export async function executeListCredentialsTool(
  step: AutoStep,
  _sessionId: string,
  context: ListCredentialsContext
): Promise<AutoToolResult> {
  console.log('🔑 [LIST-CREDENTIALS] 执行凭据查询工具');

  const { userId } = context;

  if (!userId) {
    return {
      success: false,
      error: '未获取到用户信息，无法查询凭据',
      metadata: { toolName: 'list_credentials' },
    };
  }

  try {
    // 🔥 检测 Electron 环境
    const electron = (window as any).electron;
    if (!electron?.localStorage?.listCredentialsMeta) {
      return {
        success: false,
        error: '凭据管理功能仅在桌面端可用',
        metadata: { toolName: 'list_credentials' },
      };
    }

    // 🔥 获取凭据元数据列表（不含明文值）
    const credentials = await electron.localStorage.listCredentialsMeta(userId);

    // 🔥 set 动作：写入参数（LLM 自主维护 clearWindow/updateSourceUrl 等参数）
    const params = (step.toolParams || {}) as Record<string, any>;
    if ((params.action || 'list') === 'set') {
      return await handleSetParam(electron, credentials, params.name, params.value);
    }

    if (!credentials || credentials.length === 0) {
      return {
        success: true,
        data: {
          type: 'text',
          content: '当前没有任何凭据。请让用户在「凭据管理」中添加凭据（如 SSH 密码、API Key 等）。',
          credentials: [],
        },
        metadata: { toolName: 'list_credentials' },
      };
    }

    // 🔥 格式化列表给 LLM：env 型只暴露名称和描述，param 型额外暴露值
    const lines = credentials.map((cred: any, index: number) => {
      const base = `${index + 1}. ${cred.env_var} | 描述: ${cred.description || '无'}`;
      // param 型对 LLM 透明（返回值），env 型不返回值
      return cred.value !== undefined ? `${base} | 值: ${cred.value}` : base;
    });

    const content = [
      `📋 可用凭据列表（共 ${credentials.length} 个）：`,
      '',
      ...lines,
      '',
      '💡 使用方式：在调用 userpc_shell 时传入 credentialName 参数（值为环境变量名），系统会自动将凭据值注入为同名环境变量。',
      '例如：userpc_shell(query="ssh user@host", credentialName="SSHPASS") → 自动设置 $SSHPASS 环境变量',
    ].join('\n');

    return {
      success: true,
      data: {
        type: 'text',
        content,
        credentials, // 🔥 结构化数据，前端可解析展示
      },
      metadata: { toolName: 'list_credentials' },
    };
  } catch (error: any) {
    console.error('❌ [LIST-CREDENTIALS] 查询凭据失败:', error);
    return {
      success: false,
      error: `查询凭据失败: ${error.message}`,
      metadata: { toolName: 'list_credentials' },
    };
  }
}

/**
 * 🔥 set 动作：更新已有 param 型参数的值
 * 白名单 = 现有 param 列表（按 name 精确匹配，meta 条目有 value 即 param 型）；
 * 不新建参数、不动 env 凭据；updateSourceUrl 写库后同步 autoUpdater（与凭据管理 UI 行为一致）
 */
async function handleSetParam(electron: any, credentials: any[], name: any, value: any): Promise<AutoToolResult> {
  if (!name || typeof name !== 'string') {
    return {
      success: false,
      error: 'set 需要提供 name（参数名）和 value（新值），如 action="set", name="updateSourceUrl", value="https://github.com/USER/REPO/releases/latest/download/"',
      metadata: { toolName: 'list_credentials' },
    };
  }
  if (value === undefined || value === null) {
    return {
      success: false,
      error: `set 需要提供 ${name} 的新值（value；param 型允许空字符串）`,
      metadata: { toolName: 'list_credentials' },
    };
  }

  // 🔥 只能改已存在的 param 型条目（meta 条目有 value 即 param 型，env 凭据不暴露 value）
  const target = credentials.find((c: any) => c.env_var === name && c.value !== undefined);
  if (!target) {
    const paramNames = credentials
      .filter((c: any) => c.value !== undefined)
      .map((c: any) => c.env_var)
      .join(', ');
    return {
      success: false,
      error: `参数「${name}」不存在或不可写（env 型凭据不可写、不能新建参数）。可写参数：${paramNames || '无'}`,
      metadata: { toolName: 'list_credentials' },
    };
  }

  // 🔥 数值参数范围校验（与凭据管理 UI 一致）
  const range = PARAM_RANGES[name];
  const strValue = String(value);
  if (range) {
    const num = parseInt(strValue, 10);
    if (isNaN(num) || num < range.min || num > range.max) {
      return {
        success: false,
        error: `${name} 需为 ${range.min}-${range.max} 之间的整数`,
        metadata: { toolName: 'list_credentials' },
      };
    }
  }

  const result = await electron.localStorage.updateCredential(target.id, { value: strValue, type: 'param' });
  if (!result?.success) {
    return {
      success: false,
      error: result?.error || '写入失败，请重试',
      metadata: { toolName: 'list_credentials' },
    };
  }

  // 🔥 updateSourceUrl 特判：同步到 autoUpdater（否则要重启才生效）
  if (name === 'updateSourceUrl' && electron.updater?.setSourceUrl) {
    await electron.updater.setSourceUrl(strValue.trim());
  }

  console.log(`🔑 [LIST-CREDENTIALS] 参数已更新: ${name}`);
  return {
    success: true,
    data: {
      type: 'text',
      content: `✅ 已更新参数 ${name} = ${strValue || '(空)'}`,
    },
    metadata: { toolName: 'list_credentials' },
  };
}
