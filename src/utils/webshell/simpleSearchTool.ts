import { AutoStep, AutoToolResult } from '@/utils/auto/types';
import { ToolApiClient } from '@/utils/ToolApiClient';

export interface SimpleSearchRequest {
  query: string;
  maxResults?: number;
  userId: string;
  conversationId: string;
}

export interface SimpleSearchResultItem {
  title: string;
  url: string;
  content: string;
  snippet: string;
}

export interface SimpleSearchResult {
  success: boolean;
  query: string;
  results: SimpleSearchResultItem[];
  summary: string;
  error?: string;
}

export async function executeSimpleSearchTool(
  step: AutoStep,
  planId: string,
  userId: string,
  conversationId: string
): Promise<AutoToolResult> {
  console.log('🔍 [SIMPLE-SEARCH-TOOL] 开始执行简单搜索');

  try {
    const params = step.toolParams || {};

    const request: SimpleSearchRequest = {
      query: params.query || step.description || '',
      maxResults: params.maxResults || 10, // DeepSeek 主源按次计费与条数无关，count 提到 10 白赚信息量
      userId,
      conversationId,
    };

    if (!request.query) {
      throw new Error('搜索查询不能为空');
    }

    console.log('🔍 [SIMPLE-SEARCH-TOOL] 搜索参数:', {
      query: request.query,
      maxResults: request.maxResults,
    });

    const result: SimpleSearchResult = await ToolApiClient.simpleSearch.execute(request);

    if (!result.success) {
      throw new Error(result.error || '简单搜索失败');
    }

    console.log('✅ [SIMPLE-SEARCH-TOOL] 搜索完成:', {
      resultCount: result.results.length,
      summaryLength: result.summary.length,
    });

    return {
      success: true,
      data: {
        query: result.query,
        results: result.results,
        summary: result.summary,
      },
      metadata: {
        toolName: 'simple_search',
        query: result.query,
        resultCount: result.results.length,
      },
    };
  } catch (error) {
    console.error('❌ [SIMPLE-SEARCH-TOOL] 执行失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '简单搜索工具执行失败',
      metadata: {
        toolName: 'simple_search',
      },
    };
  }
}
