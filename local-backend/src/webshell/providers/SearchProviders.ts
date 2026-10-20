/**
 * 搜索引擎 Provider 实现
 * 支持多源聚合搜索，从配置中读取搜索源
 * 支持可配置的搜索策略
 */

import fetch from 'node-fetch';
import { SearchProvider, SearchResult } from '../types';
import { userModelRegistry, SearchProviderConfig } from '../../utils/llm/UserModelRegistry';
import { HOSTED_BASE, getHostedJwt, hostedSearchProxy } from '../hostedClient';

// ============================================
// Provider 基类
// ============================================

/**
 * 通用搜索 Provider 基类
 */
abstract class BaseSearchProvider implements SearchProvider {
  abstract name: string;
  protected config: SearchProviderConfig;

  constructor(config: SearchProviderConfig) {
    this.config = config;
  }

  abstract search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]>;

  getConfig(): SearchProviderConfig {
    return this.config;
  }
}

/**
 * Tavily Search Provider
 */
export class TavilySearchProvider extends BaseSearchProvider {
  name = 'Tavily';

  constructor(config: SearchProviderConfig) {
    super(config);
    this.name = config.name || 'Tavily';
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    if (!this.config.apiKey) {
      console.warn(`[${this.name}] API Key 未配置，跳过搜索`);
      return [];
    }

    try {
      const response: any = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.apiKey,
          query,
          max_results: options?.maxResults || 10,
          include_answer: false,
          search_depth: 'advanced'
        })
      });

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const data = await response.json();
      
      return (data.results || []).map((r: any, i: number) => {
        // 🔥 限制 snippet 长度，避免 token 爆炸
        const maxLength = 1200;
        const rawContent = r.content || r.snippet || '';
        const snippet = rawContent.length > maxLength 
          ? rawContent.substring(0, maxLength) + '...' 
          : rawContent;
        
        return {
          id: `tavily_${i}_${Date.now()}`,
          title: r.title || '',
          url: r.url || '',
          snippet: snippet,
          publishedDate: r.published_date,
          source: this.name,
          score: r.score || 0.5,
          relevance: r.score || 0.5,
        };
      });
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }
}

/**
 * Qwen 联网搜索 Provider
 */
export class QwenSearchProvider extends BaseSearchProvider {
  name = 'QwenSearch';

  constructor(config: SearchProviderConfig) {
    super(config);
    this.name = config.name || 'QwenSearch';
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    if (!this.config.apiKey) {
      console.warn(`[${this.name}] API Key 未配置，跳过搜索`);
      return [];
    }

    try {
      const maxResults = options?.maxResults || 10;
      
      const response: any = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'qwen-plus',
          messages: [{
            role: 'user',
            content: `请搜索并总结关于"${query}"的最新信息，列出${maxResults}个相关网页的标题、链接和摘要。以JSON格式返回：{"results":[{"title":"...","url":"...","snippet":"..."}]}`
          }],
          extra_body: { enable_search: true },
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{"results":[]}';
      
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        console.error(`[${this.name}] JSON 解析失败:`, content);
        return [];
      }
      
      return (parsed.results || []).map((r: any, i: number) => ({
        id: `qwen_${i}_${Date.now()}`,
        title: r.title || '',
        url: r.url || '',
        snippet: r.snippet || '',
        source: this.name,
        score: 0.6,
        relevance: 0.6,
      }));
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }
}

/**
 * SerpAPI 搜索 Provider (Google Search)
 */
export class SerpAPISearchProvider extends BaseSearchProvider {
  name = 'SerpAPI';

  constructor(config: SearchProviderConfig) {
    super(config);
    this.name = config.name || 'SerpAPI';
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    if (!this.config.apiKey) {
      console.warn(`[${this.name}] API Key 未配置，跳过搜索`);
      return [];
    }

    try {
      const maxResults = options?.maxResults || 10;
      const searchParams = new URLSearchParams({
        q: query,
        api_key: this.config.apiKey,
        engine: 'google',
        num: Math.min(maxResults, 10).toString(),
      });

      const response: any = await fetch(`${this.config.url}?${searchParams.toString()}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const data = await response.json();
      const organicResults = data.organic_results || [];

      return organicResults.slice(0, maxResults).map((r: any, i: number) => ({
        id: `serpapi_${i}_${Date.now()}`,
        title: r.title || '',
        url: r.link || r.url || '',
        snippet: r.snippet || r.description || '',
        publishedDate: r.date,
        source: this.name,
        score: r.position ? 1 / r.position : 0.5,
        relevance: r.position ? 1 / r.position : 0.5,
      }));
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }
}

/**
 * Bing Search Provider
 */
export class BingSearchProvider extends BaseSearchProvider {
  name = 'Bing';

  constructor(config: SearchProviderConfig) {
    super(config);
    this.name = config.name || 'Bing';
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    if (!this.config.apiKey) {
      console.warn(`[${this.name}] API Key 未配置，跳过搜索`);
      return [];
    }

    try {
      const maxResults = options?.maxResults || 10;
      const searchParams = new URLSearchParams({
        q: query,
        count: Math.min(maxResults, 50).toString(),
        mkt: 'zh-CN',
      });

      const response: any = await fetch(`${this.config.url}?${searchParams.toString()}`, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': this.config.apiKey,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const data = await response.json();
      const webPages = data.webPages?.value || [];

      return webPages.slice(0, maxResults).map((r: any, i: number) => ({
        id: `bing_${i}_${Date.now()}`,
        title: r.name || r.title || '',
        url: r.url || r.link || '',
        snippet: r.snippet || r.description || '',
        publishedDate: r.dateLastCrawled,
        source: this.name,
        score: 0.6,
        relevance: 0.6,
      }));
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }
}

/**
 * 通用 HTTP 搜索 Provider
 * 用于自定义搜索源
 */
export class GenericSearchProvider extends BaseSearchProvider {
  name = 'Generic';

  constructor(config: SearchProviderConfig) {
    super(config);
    this.name = config.name || 'Generic';
  }

  private extractValue(obj: any, path: string): any {
    if (!path) return obj;
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  private buildRequest(query: string, maxResults: number): { url: string; method: string; headers: Record<string, string>; body?: string } {
    const template = this.config.requestTemplate;
    
    if (!template) {
      return {
        url: this.config.url,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, max_results: maxResults })
      };
    }

    let url = this.config.url;
    const headers: Record<string, string> = {};
    let body: string | undefined;

    const apiKey = this.config.apiKey || '';

    if (template.method === 'GET') {
      if (template.queryTemplate) {
        let queryString = template.queryTemplate
          .replace(/\$\{query\}/g, encodeURIComponent(query))
          .replace(/\$\{maxResults\}/g, String(maxResults));
        
        if (template.authType === 'query' && apiKey && template.authQueryParam) {
          queryString += `&${template.authQueryParam}=${encodeURIComponent(apiKey)}`;
        }
        
        url = `${this.config.url}?${queryString}`;
      }

      if (template.authType === 'header' && apiKey && template.authHeaderName) {
        headers[template.authHeaderName] = apiKey;
      }
    } else if (template.method === 'POST') {
      headers['Content-Type'] = 'application/json';

      if (template.authType === 'header' && apiKey && template.authHeaderName) {
        headers[template.authHeaderName] = apiKey;
      }

      if (template.bodyTemplate) {
        body = template.bodyTemplate
          .replace(/\$\{apiKey\}/g, apiKey)
          .replace(/\$\{query\}/g, query)
          .replace(/\$\{maxResults\}/g, String(maxResults));
      } else if (template.authType === 'body' && apiKey && template.authQueryParam) {
        body = JSON.stringify({
          [template.authQueryParam]: apiKey,
          query,
          max_results: maxResults
        });
      } else {
        body = JSON.stringify({ query, max_results: maxResults });
      }
    }

    return { url, method: template.method, headers, body };
  }

  private parseResponse(data: any): SearchResult[] {
    const template = this.config.responseTemplate;

    if (!template) {
      const results = data.results || data.data || data.items || [];
      return results.map((r: any, i: number) => ({
        id: `${this.name.toLowerCase()}_${i}_${Date.now()}`,
        title: r.title || r.name || '',
        url: r.url || r.link || r.href || '',
        snippet: r.snippet || r.content || r.description || r.summary || '',
        source: this.name,
        score: r.score || r.relevance || 0.5,
        relevance: r.score || r.relevance || 0.5,
      }));
    }

    const resultsArray = this.extractValue(data, template.resultsPath) || [];
    
    return resultsArray.map((r: any, i: number) => ({
      id: `${this.name.toLowerCase()}_${i}_${Date.now()}`,
      title: this.extractValue(r, template.titlePath) || '',
      url: this.extractValue(r, template.urlPath) || '',
      snippet: this.extractValue(r, template.snippetPath) || '',
      source: this.name,
      score: 0.5,
      relevance: 0.5,
    }));
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    const template = this.config.requestTemplate;
    const needApiKey = template?.authType !== 'none';
    
    if (needApiKey && !this.config.apiKey) {
      console.warn(`[${this.name}] API Key 未配置，跳过搜索`);
      return [];
    }

    try {
      const maxResults = options?.maxResults || 10;
      const requestConfig = this.buildRequest(query, maxResults);

      console.log(`[${this.name}] 发送请求:`, requestConfig.url);

      const response: any = await fetch(requestConfig.url, {
        method: requestConfig.method,
        headers: requestConfig.headers,
        body: requestConfig.body
      });

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const data = await response.json();
      return this.parseResponse(data);
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }
}

/**
 * HuggingFace Model Search Provider
 * 搜索 HuggingFace 上的开源模型
 */
export class HuggingFaceSearchProvider extends BaseSearchProvider {
  name = 'HuggingFace';

  constructor(config: SearchProviderConfig) {
    super(config);
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    try {
      const maxResults = options?.maxResults || 10;

      // HuggingFace API 不需要 API Key 进行搜索
      const searchUrl = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${maxResults}`;

      // 添加超时控制（5秒），避免 HuggingFace 访问慢导致整体搜索阻塞
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response: any = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {})
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const models = await response.json();

      return models.map((model: any, i: number) => {
        const modelId = model.modelId || model.id || '';
        const downloads = model.downloads || 0;
        const likes = model.likes || 0;
        const tags = model.tags || [];
        
        // 构建描述文本
        let snippet = model.description || '';
        if (tags.length > 0) {
          snippet += `\n标签: ${tags.slice(0, 5).join(', ')}`;
        }
        snippet += `\n下载: ${downloads.toLocaleString()} | 点赞: ${likes}`;

        return {
          id: `huggingface_${i}_${Date.now()}`,
          title: modelId,
          url: `https://huggingface.co/${modelId}`,
          snippet: snippet.trim(),
          publishedDate: model.lastModified,
          source: this.name,
          score: (likes / 1000) + (downloads / 10000),
          relevance: Math.min(0.9, (likes / 1000) + (downloads / 10000)),
        };
      });
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }
}

/**
 * arXiv Paper Search Provider
 * 搜索 arXiv 学术论文
 */
export class ArxivSearchProvider extends BaseSearchProvider {
  name = 'arXiv';

  constructor(config: SearchProviderConfig) {
    super(config);
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    try {
      const maxResults = options?.maxResults || 10;
      
      // arXiv API (无需 API Key)
      const searchUrl = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;
      
      const response: any = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/xml',
        }
      });

      if (!response.ok) {
        console.error(`[${this.name}] API 错误:`, await response.text());
        return [];
      }

      const xmlText = await response.text();
      
      // 解析 XML 响应
      const entries = this.parseArxivXml(xmlText);

      return entries.map((entry: any, i: number) => ({
        id: `arxiv_${i}_${Date.now()}`,
        title: entry.title || '',
        url: entry.pdfUrl || entry.id || '',
        snippet: entry.summary || '',
        publishedDate: entry.published,
        source: this.name,
        score: 0.8,
        relevance: 0.8,
      }));
    } catch (error) {
      console.error(`[${this.name}] 搜索失败:`, error);
      return [];
    }
  }

  private parseArxivXml(xmlText: string): any[] {
    const entries: any[] = [];
    
    // 简单的 XML 解析
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    
    while ((match = entryRegex.exec(xmlText)) !== null) {
      const entryXml = match[1];
      
      const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
      const idMatch = entryXml.match(/<id>([\s\S]*?)<\/id>/);
      const publishedMatch = entryXml.match(/<published>([\s\S]*?)<\/published>/);
      const pdfMatch = entryXml.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/);
      
      if (titleMatch) {
        entries.push({
          title: this.cleanXmlText(titleMatch[1]),
          summary: this.cleanXmlText(summaryMatch?.[1] || ''),
          id: this.cleanXmlText(idMatch?.[1] || ''),
          published: this.cleanXmlText(publishedMatch?.[1] || ''),
          pdfUrl: pdfMatch ? pdfMatch[1] : this.cleanXmlText(idMatch?.[1] || ''),
        });
      }
    }
    
    return entries;
  }

  private cleanXmlText(text: string): string {
    return text
      .replace(/<[^>]+>/g, '') // 移除所有标签
      .replace(/\s+/g, ' ')     // 合并空白
      .trim();
  }
}

/**
 * 官方 hosted 搜索 Provider
 * 走 homeweb /api/search-proxy，服务端聚合 zhipu/tavily/arxiv 并做策略路由，本地无需配 Key
 */
export class HostedSearchProvider implements SearchProvider {
  name = 'Hosted';
  private config: SearchProviderConfig;

  constructor() {
    this.config = {
      id: 'hosted-official',
      name: 'Hosted',
      type: 'search',
      providerType: 'hosted',
      url: HOSTED_BASE,
      apiKey: '',
      isGeneral: true,
      description: '官方搜索通道（智谱/Tavily/arXiv 聚合）',
    };
  }

  getConfig(): SearchProviderConfig {
    return this.config;
  }

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    // 不吞错：云端错误（欠费 402 / 全源失败 502 / 超时）直接上抛，由聚合层判断
    const data: any = await hostedSearchProxy({
      action: 'search',
      query,
      maxResults: options?.maxResults || 10,
    });
    return (data?.results || []).map((r: any, i: number) => ({
      id: `hosted_${i}_${Date.now()}`,
      title: r.title || '',
      url: r.url || '',
      // 摘要够判断相关性即可，全文走 fetch 爬取；并行多路搜索时防爆上下文
      snippet: String(r.snippet || '').slice(0, 300),
      publishedDate: r.published,
      source: r.source || 'hosted',
      score: r.relevance || 0.5,
      relevance: r.relevance || 0.5,
    }));
  }
}

/**
 * 聚合搜索 Provider（薄透传层）
 * 登录用户 → 官方 hosted 通道（策略路由/熔断都在云端 services 层）；
 * 未登录云端 token 的用户 → 用户历史配置的本地源直连。
 * 本层只做：并行执行 + URL 去重排序 + 全源失败如实抛错。
 */
export class AggregateSearchProvider implements SearchProvider {
  name = 'Aggregate';
  private providers: SearchProvider[] = [];
  private currentUserId: string | null = null;

  constructor(userId?: string) {
    this.currentUserId = userId || null;
    this.loadProvidersFromConfig();
  }

  /**
   * 设置当前用户ID并重新加载搜索源
   */
  setUserId(userId: string): void {
    if (this.currentUserId !== userId) {
      console.log(`[AggregateSearch] 切换用户: ${this.currentUserId || 'null'} -> ${userId}`);
      this.currentUserId = userId;
      this.loadProvidersFromConfig();
    }
  }

  /**
   * 从配置加载搜索源
   * 根据 providerType 选择对应的 Provider 实现
   */
  private loadProvidersFromConfig(): void {
    // 🔥 拒绝 default 用户或空用户
    if (!this.currentUserId || this.currentUserId === 'default') {
      console.warn(`[AggregateSearch] 拒绝为未登录用户加载搜索源`);
      this.providers = [];
      return;
    }

    // 🔥 登录用户一律走官方 hosted 通道：历史本地配置忽略（UI 已隐藏，渠道质量不可控，
    //    曾出现 arXiv 限流 + HuggingFace 超时拖死新闻类查询的事故）
    if (getHostedJwt()) {
      console.log(`[AggregateSearch] 使用官方 hosted 通道 (用户: ${this.currentUserId})`);
      this.providers = [new HostedSearchProvider()];
      return;
    }

    try {
      // 🔥 设置当前用户，确保加载正确的用户配置
      userModelRegistry.setCurrentUser(this.currentUserId);
      const configs = userModelRegistry.getAllSearchProviders();

      this.providers = configs
        .filter((config: SearchProviderConfig) => {
          // 🔥 只加载 type 为 search 的搜索源
          if (config.type !== 'search') return false;
          
          // 🔥 对于不需要 API Key 的搜索源（huggingface, arxiv），允许空 apiKey
          const noApiKeyRequired = ['huggingface', 'arxiv'].includes(config.providerType || '');
          if (noApiKeyRequired) return true;
          
          // 其他搜索源需要 API Key
          return !!config.apiKey;
        })
        .map((config: SearchProviderConfig) => {
          // 根据 providerType 选择对应的 Provider 实现
          switch (config.providerType) {
            case 'tavily':
              return new TavilySearchProvider(config);
            case 'qwen':
              return new QwenSearchProvider(config);
            case 'serpapi':
              return new SerpAPISearchProvider(config);
            case 'bing':
              return new BingSearchProvider(config);
            case 'huggingface':
              return new HuggingFaceSearchProvider(config);
            case 'arxiv':
              return new ArxivSearchProvider(config);
            default:
              console.warn(`[AggregateSearch] 未知的搜索源类型: ${config.providerType}，使用通用 Provider`);
              return new GenericSearchProvider(config);
          }
        });

      console.log(`[AggregateSearch] 已加载 ${this.providers.length} 个搜索源 (用户: ${this.currentUserId})`);
    } catch (error) {
      console.error('[AggregateSearch] 加载搜索源失败:', error);
      this.providers = [];
    }
  }

  async search(query: string, options?: { maxResults?: number; userId?: string }): Promise<SearchResult[]> {
    // 🔥 如果传入了 userId，切换到对应用户
    if (options?.userId) {
      this.setUserId(options.userId);
    }

    // 🔥 只在第一次或providers为空时加载配置
    if (this.providers.length === 0) {
      this.loadProvidersFromConfig();
    }

    if (this.providers.length === 0) {
      console.warn('[AggregateSearch] 没有可用的搜索源');
      return [];
    }

    const maxResults = options?.maxResults || 10;
    console.log(`[AggregateSearch] ${this.providers.length} 个搜索源，目标 ${maxResults} 条: ${this.providers.map(p => p.name).join(', ')}`);

    // 并行执行所有源（每个源给足 maxResults，聚合后去重裁剪）
    const failures: string[] = [];
    const results = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          const providerResults = await provider.search(query, { maxResults });
          console.log(`[${provider.name}] 返回 ${providerResults.length} 个结果`);
          return providerResults;
        } catch (err) {
          failures.push(`${provider.name}: ${(err as any)?.message || err}`);
          console.warn(`[${provider.name}] 搜索失败:`, err);
          return [];
        }
      })
    );

    const ranked = this.processAndRankResults(results.flat(), maxResults);
    if (ranked.length === 0 && failures.length > 0 && failures.length === this.providers.length) {
      throw new Error(`所有搜索源失败: ${failures.join('; ').slice(0, 300)}`);
    }
    return ranked;
  }

  /**
   * 处理和排序结果
   */
  private processAndRankResults(
    allResults: SearchResult[],
    maxResults: number
  ): SearchResult[] {
    console.log(`[AggregateSearch] 总计收集 ${allResults.length} 个结果`);

    // 去重
    const uniqueResults = this.deduplicateByUrl(allResults);
    console.log(`[AggregateSearch] 去重后剩余 ${uniqueResults.length} 个结果`);

    // 按相关性排序
    return uniqueResults.sort((a, b) => b.relevance - a.relevance).slice(0, maxResults);
  }

  private deduplicateByUrl(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    return results.filter(result => {
      const normalizedUrl = this.normalizeUrl(result.url);
      if (seen.has(normalizedUrl)) return false;
      seen.add(normalizedUrl);
      return true;
    });
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  /**
   * 获取当前可用的搜索源数量
   */
  getProviderCount(): number {
    return this.providers.length;
  }
}

/**
 * 创建聚合搜索 Provider 的工厂函数
 */
export function createAggregateSearchProvider(): AggregateSearchProvider {
  return new AggregateSearchProvider();
}
