/**
 * Tool API Client - 统一网关
 *
 * 为所有 Tool 提供统一的后端 API 调用入口
 */

import { getBackendUrl } from "@/config/api";

export const ToolApiRoutes = {
  DEEP_RESEARCH: {
    EXECUTE: '/webshell/deepresearch',
  },
  
  SIMPLE_SEARCH: {
    EXECUTE: '/simplesearch',
  },

  URL_READER: {
    PROCESS: '/webshell/urlreader',
  },
  
  FILE_INTELLIGENCE: {
    GENERATE_METADATA: '/file-intelligence/generate-metadata',
  },
  
  OSS: {
    UPLOAD: '/oss/upload',
    DELETE: '/oss/delete',
  },
  
  MEMORY: {
    SEARCH: '/api/local/conversations/search',
    CONTEXT: '/api/local/conversations/memory/context',
    SESSION: '/api/local/conversations',
    PROJECT_SAVE: '/api/local/desktop-apps/project-memory/save',
    PROJECT_QUERY: '/api/local/desktop-apps/project-memory',
  },

  SEARCH_PROVIDER: {
    SAVE: '/api/llm-models/search-providers',
    GET: '/api/llm-models/search-providers',
  },
} as const;

interface ToolRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const getEcsBaseUrl = (): string => {
  return getBackendUrl();
};

async function toolRequest<T>(
  endpoint: string,
  options: ToolRequestOptions = {}
): Promise<T> {
  const baseUrl = getEcsBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  const {
    method = 'POST',
    body,
    headers = {},
    signal,
  } = options;

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 调用失败 [${response.status}]: ${errorText}`);
    }

    // 处理可能非 JSON 的响应
    const responseText = await response.text();
    try {
      return JSON.parse(responseText);
    } catch (parseError) {
      // 如果不是有效的 JSON，返回一个包含原始文本的对象
      return {
        success: false,
        error: `服务器返回非 JSON 响应: ${responseText.substring(0, 200)}`,
        rawResponse: responseText
      } as unknown as T;
    }
  } catch (error) {
    // 🔥 处理 AbortError
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('🛑 [ToolApiClient] 请求被中断');
      throw error;
    }
    throw error;
  }
}

export const ToolApiClient = {
  request: toolRequest,

  deepResearch: {
    execute: (body: {
      query: string;
      userId: string;
      conversationId: string;
      options?: {
        maxSources?: number;
        depth?: string;
        includeAcademic?: boolean;
        language?: string;
        timeRange?: number;
        domain?: string;
      };
    }) => toolRequest<any>(ToolApiRoutes.DEEP_RESEARCH.EXECUTE, { body }),
  },

  simpleSearch: {
    execute: (body: {
      query: string;
      userId: string;
      conversationId: string;
      maxResults?: number;
    }) => toolRequest<any>(ToolApiRoutes.SIMPLE_SEARCH.EXECUTE, { body }),
  },

  urlReader: {
    process: (body: {
      url: string;
      userQuery?: string;
      userId: string;
      conversationId: string;
    }) => toolRequest<any>(ToolApiRoutes.URL_READER.PROCESS, { body }),
  },

  memory: {
    search: (params: {
      keyword: string;
      userId: string;
      conversationId?: string;
      limit?: number;
    }) => toolRequest<any>(`${ToolApiRoutes.MEMORY.SEARCH}?q=${encodeURIComponent(params.keyword)}&user_id=${params.userId}${params.conversationId ? `&conversation_id=${params.conversationId}` : ''}&limit=${params.limit || 50}`, {
      method: 'GET',
    }),

    getContext: (params: {
      conversationId: string;
      messageId: string;
      before: number;
      after: number;
    }) => toolRequest<any>(`${ToolApiRoutes.MEMORY.CONTEXT}?conversation_id=${params.conversationId}&message_id=${params.messageId}&before=${params.before}&after=${params.after}`, {
      method: 'GET',
    }),

    getSession: (params: {
      conversationId: string;
      sessionId: string;
    }) => toolRequest<any>(`${ToolApiRoutes.MEMORY.SESSION}/${params.conversationId}/messages/session?sessionId=${params.sessionId}`, {
      method: 'GET',
    }),

    /** 🔥 保存项目记忆（ReAct 任务完成收尾时触发；多项目任务每个归属项目存一条） */
    saveProjectMemory: (params: {
      userId: string;
      projectIds: string[];
      userQuery: string;
      writeNote: string;
      conversationId?: string;
    }) => toolRequest<any>(`${ToolApiRoutes.MEMORY.PROJECT_SAVE}`, {
      body: {
        user_id: params.userId,
        project_ids: params.projectIds,
        user_query: params.userQuery,
        write_note: params.writeNote,
        conversation_id: params.conversationId,
      },
    }),

    /** 🔥 查询项目记忆：无 query 翻档案（时间倒序），有 query 打分定向查 */
    queryProjectMemory: (params: {
      userId: string;
      projectId: string;
      query?: string;
      limit?: number;
    }) => toolRequest<any>(`${ToolApiRoutes.MEMORY.PROJECT_QUERY}?user_id=${encodeURIComponent(params.userId)}&project_id=${encodeURIComponent(params.projectId)}${params.query ? `&query=${encodeURIComponent(params.query)}` : ''}&limit=${params.limit || 5}`, {
      method: 'GET',
    }),
  },

  searchProvider: {
    save: (body: any, userId?: string) => {
      const endpoint = userId 
        ? `${ToolApiRoutes.SEARCH_PROVIDER.SAVE}?userId=${userId}`
        : ToolApiRoutes.SEARCH_PROVIDER.SAVE;
      console.log(`[ToolApiClient] searchProvider.save 调用, userId: ${userId}, endpoint: ${endpoint}`);
      return toolRequest<any>(endpoint, { body });
    },
    get: (userId: string) => toolRequest<any>(`${ToolApiRoutes.SEARCH_PROVIDER.GET}?userId=${userId}`, { method: 'GET' }),
  },
};

export default ToolApiClient;
