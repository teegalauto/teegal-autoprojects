/**
 * Simple Search 路由 - /simplesearch
 *
 * 薄透传：调 webshell 聚合搜索 Provider（登录用户走官方 hosted 通道），
 * 结果直接格式化返回（不做 LLM 总结，避免 Token 浪费）。
 */
import { Router } from 'express';
import { AggregateSearchProvider } from '../webshell/providers/SearchProviders';

const router = Router();
const searchProvider = new AggregateSearchProvider();

/** 格式化搜索结果为 markdown 摘要 */
function formatResults(query: string, results: Array<{ title: string; url: string; snippet: string }>): string {
  if (results.length === 0) {
    return `关于"${query}"未找到相关搜索结果。`;
  }
  const lines: string[] = [`## "${query}" 的搜索结果`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title || '无标题'}**`);
    lines.push(`   ${r.snippet || ''}`);
    lines.push(`   [来源](${r.url})`);
    lines.push('');
  });
  return lines.join('\n');
}

/** 搜索不可用提示（官方通道模式下仅未登录会走到这里） */
const NO_SOURCE_MESSAGE = `## 🔍 搜索服务不可用

当前未登录（或登录态已失效），官方搜索通道无法使用。

如果你是 agent，请立即停止后续搜索请求或绕开搜索，并向用户反馈以下信息：
- 请先在应用内登录账号，登录后搜索将自动走官方通道（无需配置任何搜索源）。
- 登录后重新发起搜索请求即可。`;

/**
 * Simple Search 服务
 * POST /simplesearch
 */
router.post('/', async (req, res) => {
  try {
    const { query, maxResults, userId } = req.body || {};

    if (!query) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数: query'
      });
    }

    console.log('🔍 [SIMPLE-SEARCH] 接收 Simple Search 请求:', { query, maxResults, userId });

    searchProvider.setUserId(userId || '');

    if (searchProvider.getProviderCount() === 0) {
      console.warn('[SIMPLE-SEARCH] 搜索通道不可用（未登录或无可用搜索源）');
      return res.status(500).json({
        success: false,
        query,
        results: [],
        summary: NO_SOURCE_MESSAGE,
        error: '未登录，官方搜索通道不可用'
      });
    }

    const wanted = maxResults || 10;
    const searchResults = await searchProvider.search(query, { maxResults: wanted });

    console.log(`✅ [SIMPLE-SEARCH] 搜索返回 ${searchResults.length} 个结果`);

    const results = searchResults.slice(0, wanted).map((item: any) => ({
      title: item.title || '',
      url: item.url || '',
      content: item.snippet || '',
      snippet: item.snippet || item.title || ''
    }));

    res.json({
      success: true,
      query,
      results,
      summary: formatResults(query, results)
    });
  } catch (error) {
    // 聚合层抛出的错误（欠费 402 / 全源失败 / 超时）如实透传给调用方
    console.error('❌ [SIMPLE-SEARCH] Simple Search 处理失败:', error);
    res.status(500).json({
      success: false,
      query: req.body?.query || '',
      results: [],
      summary: '',
      error: error instanceof Error ? error.message : 'Simple Search 服务异常'
    });
  }
});

export default router;
