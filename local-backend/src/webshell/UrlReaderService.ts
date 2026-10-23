/**
 * URL Reader 服务 - 简化版
 * 使用 FetchProviders 爬取 URL 内容，支持网页文章、YouTube视频、B站视频等
 */

import { FirecrawlFetchProvider, NativeFetchProvider, JinaFetchProvider, contentCache } from './providers/FetchProviders';
import { hostedFetch } from './hostedClient';
import { userModelRegistry, SimpleUserModel } from '../utils/llm/UserModelRegistry';
import { modelBindingRegistry } from '../utils/llm/ModelBindingRegistry';
import { llmService, ContentPart, LLMMessage } from '../utils/LLMService';
import { isMultimodalModel, isVideoCapableModel } from '../shared/visionModels';
import * as fs from 'fs';

export interface UrlReaderRequest {
  url: string;
  userQuery?: string;
  userId: string;
  conversationId?: string;
  // 🔥 分块读取参数
  chunkId?: string; // 块访问ID，用于读取指定分块
}

export interface UrlReaderResponse {
  success: boolean;
  url: string;
  title?: string;
  content?: string;
  summary?: string;
  mediaType?: 'web' | 'youtube' | 'bilibili' | 'article' | 'audio' | 'video' | 'image' | 'unknown';
  llmSummary?: string;
  metadata?: {
    author?: string;
    publishedDate?: string;
    domain?: string;
    // 🔥 分块读取相关字段
    currentChunk?: number;
    totalChunks?: number;
    chunkIds?: string[];
    totalLength?: number;
    isPDF?: boolean;
    truncated?: boolean;
    // 🔥 视觉理解使用的模型（图片/视频场景）
    visionModel?: string;
  };
  error?: string;
}

export class UrlReaderService {
  private firecrawlProvider: FirecrawlFetchProvider | null = null;
  private jinaProvider: JinaFetchProvider | null = null;
  private nativeProvider: NativeFetchProvider;

  constructor() {
    this.nativeProvider = new NativeFetchProvider();
    this.initProviders();
  }

  /**
   * 初始化爬取 Providers
   */
  private initProviders() {
    try {
      // 尝试从 UserModelRegistry 获取配置
      const firecrawlConfig = userModelRegistry.getFetchProviderConfig('firecrawl');
      if (firecrawlConfig?.apiKey) {
        this.firecrawlProvider = new FirecrawlFetchProvider(firecrawlConfig);
        console.log('✅ [URL-READER-SERVICE] Firecrawl Provider 已初始化');
      }

      const jinaConfig = userModelRegistry.getFetchProviderConfig('jina');
      if (jinaConfig?.apiKey) {
        this.jinaProvider = new JinaFetchProvider(jinaConfig);
        console.log('✅ [URL-READER-SERVICE] Jina Provider 已初始化');
      }
    } catch (error) {
      console.warn('⚠️ [URL-READER-SERVICE] Provider 初始化失败:', error);
    }
  }

  /**
   * 处理 URL - 使用 FetchProviders 爬取内容
   * 🔥 支持分块读取长文档
   */
  async processUrl(request: UrlReaderRequest): Promise<UrlReaderResponse> {
    try {
      console.log('🔗 [URL-READER-SERVICE] 开始处理 URL:', request.url);

      const url = request.url;

      // 🔥 检查是否是分块读取请求
      if (request.chunkId) {
        console.log(`📄 [URL-READER-SERVICE] 分块读取: chunkId=${request.chunkId}`);
        const chunkResult = this.nativeProvider.fetchByChunkId(request.chunkId);
        if (!chunkResult) {
          return {
            success: false,
            url,
            error: '分块内容已过期，请重新读取完整文档'
          };
        }

        return {
          success: true,
          url: chunkResult.metadata.url,
          title: chunkResult.metadata.title,
          content: chunkResult.content,
          mediaType: 'web',
          metadata: {
            domain: new URL(chunkResult.metadata.url).hostname,
            currentChunk: chunkResult.metadata.currentChunk,
            totalChunks: chunkResult.metadata.totalChunks,
          },
          summary: `已读取文档第 ${chunkResult.metadata.currentChunk}/${chunkResult.metadata.totalChunks} 份内容`
        };
      }

      const mediaType = this.detectMediaType(url);
      console.log('📁 [URL-READER-SERVICE] 媒体类型:', mediaType);

      let result: UrlReaderResponse;

      // 对于网页/文章类型，优先使用 FetchProviders
      if (mediaType === 'web' || mediaType === 'article') {
        result = await this.fetchWebContent(url, request.userQuery);
      } else {
        // 其他类型保持原有处理逻辑
        switch (mediaType) {
          case 'youtube':
            result = await this.processYouTube(url, request.userQuery);
            break;
          case 'bilibili':
            result = await this.processBilibili(url, request.userQuery);
            break;
          case 'audio':
            result = await this.processMedia(url, mediaType, request.userQuery);
            break;
          // 🔥 图片/视频走视觉模型理解（用户模型表中第一个支持视觉的模型）
          case 'image':
          case 'video':
            result = await this.processVisualMedia(url, mediaType, request.userQuery, request.userId);
            break;
          default:
            result = await this.fetchWebContent(url, request.userQuery);
        }
      }

      // 🔥 直接返回原始内容，不再调用 LLM 总结
      // Reactor 会自己分析内容，避免多次搜索时的 Token 浪费
      console.log('✅ [URL-READER-SERVICE] URL 处理完成，直接返回原始内容');
      return result;

    } catch (error) {
      console.error('❌ [URL-READER-SERVICE] 处理失败:', error);
      return {
        success: false,
        url: request.url,
        error: error instanceof Error ? error.message : 'URL 处理失败'
      };
    }
  }

  /**
   * 🔥 使用 FetchProviders 爬取网页内容
   */
  private async fetchWebContent(url: string, userQuery?: string): Promise<UrlReaderResponse> {
    console.log('🔍 [URL-READER-SERVICE] 使用 FetchProviders 爬取网页');

    let lastError: Error | null = null;

    // 1. 优先尝试 Firecrawl（效果最好）
    if (this.firecrawlProvider) {
      try {
        console.log('🚀 [URL-READER-SERVICE] 尝试 Firecrawl...');
        const result = await this.firecrawlProvider.fetch(url);
        console.log('✅ [URL-READER-SERVICE] Firecrawl 成功');
        return {
          success: true,
          url,
          title: result.metadata?.title || '网页内容',
          content: result.content,
          mediaType: 'web',
          metadata: {
            author: result.metadata?.author,
            publishedDate: result.metadata?.publishedDate,
            domain: result.metadata?.domain,
          },
          summary: userQuery ? `已获取网页内容，可以根据"${userQuery}"进行分析` : '网页内容已提取'
        };
      } catch (error) {
        console.warn('⚠️ [URL-READER-SERVICE] Firecrawl 失败:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // 2. 官方 hosted 通道（服务端 firecrawl，登录即可用，无需本地配 Key；未登录直接抛错落到下一级）
    try {
      console.log('🚀 [URL-READER-SERVICE] 尝试官方 hosted 通道 (Firecrawl)...');
      const result = await hostedFetch(url);
      if (result.content) {
        console.log('✅ [URL-READER-SERVICE] 官方 hosted 通道成功');
        return {
          success: true,
          url,
          title: result.metadata?.title || '网页内容',
          content: result.content,
          mediaType: 'web',
          metadata: {
            author: result.metadata?.author,
            publishedDate: result.metadata?.publishedDate,
            domain: result.metadata?.domain,
          },
          summary: userQuery ? `已获取网页内容，可以根据"${userQuery}"进行分析` : '网页内容已提取'
        };
      }
      console.warn('⚠️ [URL-READER-SERVICE] 官方 hosted 通道返回空内容，落到下一级');
    } catch (error) {
      console.warn('⚠️ [URL-READER-SERVICE] 官方 hosted 通道失败:', error);
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    // 3. 尝试 Jina AI Reader
    if (this.jinaProvider) {
      try {
        console.log('🚀 [URL-READER-SERVICE] 尝试 Jina AI Reader...');
        const result = await this.jinaProvider.fetch(url);
        console.log('✅ [URL-READER-SERVICE] Jina 成功');
        return {
          success: true,
          url,
          title: result.metadata?.title || '网页内容',
          content: result.content,
          mediaType: 'web',
          metadata: {
            domain: result.metadata?.domain,
          },
          summary: userQuery ? `已获取网页内容，可以根据"${userQuery}"进行分析` : '网页内容已提取'
        };
      } catch (error) {
        console.warn('⚠️ [URL-READER-SERVICE] Jina 失败:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // 4. 使用原生 Fetch 作为兜底
    try {
      console.log('🚀 [URL-READER-SERVICE] 使用原生 Fetch...');
      const result = await this.nativeProvider.fetch(url);
      console.log('✅ [URL-READER-SERVICE] 原生 Fetch 成功');
      return {
        success: true,
        url,
        title: result.metadata?.title || '网页内容',
        content: result.content,
        mediaType: 'web',
        metadata: {
          domain: result.metadata?.domain,
        },
        summary: userQuery ? `已获取网页内容，可以根据"${userQuery}"进行分析` : '网页内容已提取'
      };
    } catch (error) {
      console.error('❌ [URL-READER-SERVICE] 原生 Fetch 失败:', error);
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        url,
        error: `所有爬取方式均失败: ${lastError?.message || errorMessage}`
      };
    }
  }

  /**
   * 检测媒体类型
   */
  private detectMediaType(url: string): UrlReaderResponse['mediaType'] {
    const lowerUrl = url.toLowerCase();

    if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
      return 'youtube';
    }
    if (lowerUrl.includes('bilibili.com') || lowerUrl.includes('b23.tv')) {
      return 'bilibili';
    }
    // 🔥 OSS/COS 直链通常带签名参数（如 file.png?Expires=...），扩展名后需匹配 ?&# 或结尾
    if (lowerUrl.match(/\.(mp3|wav|ogg|m4a|flac|aac)(\?|&|#|$)/i)) {
      return 'audio';
    }
    if (lowerUrl.match(/\.(mp4|webm|mov|avi|mkv)(\?|&|#|$)/i)) {
      return 'video';
    }
    if (lowerUrl.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|&|#|$)/i)) {
      return 'image';
    }

    return 'web';
  }

  /**
   * 处理 YouTube 视频
   */
  private async processYouTube(url: string, userQuery?: string): Promise<UrlReaderResponse> {
    try {
      console.log('🔍 [URL-READER-SERVICE] 开始分析 YouTube 视频');

      const videoId = this.extractYouTubeVideoId(url);
      if (!videoId) {
        return { success: false, url, error: '无法解析 YouTube 视频 ID' };
      }

      // 尝试使用 Firecrawl 获取 YouTube 信息
      if (this.firecrawlProvider) {
        try {
          const result = await this.firecrawlProvider.fetch(url);
          return {
            success: true,
            url,
            title: result.metadata?.title || 'YouTube 视频',
            content: result.content,
            mediaType: 'youtube',
            metadata: result.metadata,
            summary: userQuery ? `已获取 YouTube 视频信息，可以根据"${userQuery}"进行分析` : 'YouTube 视频内容已提取'
          };
        } catch (e) {
          console.warn('⚠️ Firecrawl YouTube 失败，使用备用方案');
        }
      }

      // 备用方案：使用 oEmbed API
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      let videoInfo: { title?: string; author_name?: string } = {};

      try {
        const response = await fetch(oembedUrl);
        if (response.ok) {
          videoInfo = await response.json() as { title?: string; author_name?: string };
        }
      } catch (e) {
        console.warn('⚠️ oEmbed API 调用失败:', e);
      }

      const content = `【YouTube 视频】
标题: ${videoInfo.title || '未知'}
作者: ${videoInfo.author_name || '未知'}
链接: https://www.youtube.com/watch?v=${videoId}

【说明】
由于技术限制，无法直接获取视频的完整字幕。如需深度分析，建议下载视频字幕文件后上传。`;

      return {
        success: true,
        url,
        title: videoInfo.title || 'YouTube 视频',
        content,
        mediaType: 'youtube',
        summary: userQuery ? `已获取 YouTube 视频基本信息，可以根据"${userQuery}"进行分析` : 'YouTube 视频信息已提取'
      };

    } catch (error) {
      console.error('❌ [URL-READER-SERVICE] YouTube 处理失败:', error);
      return { success: false, url, error: `YouTube 处理失败: ${error instanceof Error ? error.message : '未知错误'}` };
    }
  }

  /**
   * 处理 B站 视频
   */
  private async processBilibili(url: string, userQuery?: string): Promise<UrlReaderResponse> {
    try {
      console.log('🔍 [URL-READER-SERVICE] 开始分析 B站 视频');

      const videoIdMatch = url.match(/(?:av\d+|BV[\w]+)/i);
      const videoId = videoIdMatch ? videoIdMatch[0] : '';

      let videoInfo: { title?: string; description?: string; author?: string } = {};

      try {
        const apiUrl = `https://api.bilibili.com/x/web-interface/view?${videoId.startsWith('BV') ? 'bvid' : 'aid'}=${videoId.replace(/[^0-9a-zA-Z]/g, '')}`;
        const response = await fetch(apiUrl);
        if (response.ok) {
          const data = await response.json() as { code: number; data?: { title?: string; desc?: string; owner?: { name?: string } } };
          if (data.code === 0 && data.data) {
            videoInfo = {
              title: data.data.title,
              description: data.data.desc,
              author: data.data.owner?.name
            };
          }
        }
      } catch (e) {
        console.warn('⚠️ B站 API 调用失败:', e);
      }

      let content = `【B站 视频】
标题: ${videoInfo.title || '未知'}
作者: ${videoInfo.author || '未知'}
`;

      if (videoInfo.description) {
        content += `\n【视频简介】\n${videoInfo.description}\n`;
      }

      content += `\n链接: ${url}\n\n【说明】\nB站视频的完整字幕需要登录后才能获取。`;

      return {
        success: true,
        url,
        title: videoInfo.title || 'B站 视频',
        content,
        mediaType: 'bilibili',
        summary: userQuery ? `已获取 B站 视频信息，可以根据"${userQuery}"进行分析` : 'B站 视频信息已提取'
      };

    } catch (error) {
      console.error('❌ [URL-READER-SERVICE] B站 处理失败:', error);
      return { success: false, url, error: `B站 处理失败: ${error instanceof Error ? error.message : '未知错误'}` };
    }
  }

  /**
   * 处理音视频文件
   * 🔥 fileAnalysis 模块已清理，音视频分析功能降级为仅返回文件信息
   */
  private async processMedia(url: string, mediaType: 'audio' | 'video', userQuery?: string): Promise<UrlReaderResponse> {
    try {
      console.log(`🔍 [URL-READER-SERVICE] 接收 ${mediaType} 文件（分析功能已降级）`);

      return {
        success: true,
        url,
        title: this.getFileNameFromUrl(url),
        content: `${mediaType === 'audio' ? '音频' : '视频'}文件已接收`,
        mediaType,
        summary: `${mediaType === 'audio' ? '音频' : '视频'}文件已接收，详细分析功能暂不可用`
      };
    } catch (error) {
      console.error(`❌ [URL-READER-SERVICE] ${mediaType} 处理失败:`, error);
      return { success: false, url, error: `${mediaType} 处理失败: ${error instanceof Error ? error.message : '未知错误'}` };
    }
  }

  private getFileNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const fileName = pathname.split('/').pop() || 'unknown';
      return decodeURIComponent(fileName);
    } catch {
      return 'unknown';
    }
  }

  // ========== 🔥 视觉媒体理解（图片/视频） ==========

  /**
   * 🔥 查找用户模型表中支持视觉的模型（返回候选列表，调用侧逐个降级尝试）
   * - 图片：所有视觉模型
   * - 视频：仅限支持视频理解的模型（qwen-vl / gemini），图片级视觉模型不兜底
   *   hasImageOnlyVision = 有视觉模型但都不支持视频（用于给出精确提示）
   */
  private findVisionModels(
    userId: string,
    mediaType: 'image' | 'video'
  ): { models: SimpleUserModel[]; hasImageOnlyVision: boolean } {
    try {
      // 🔥 与 LLMService 的校验口径一致：有 apiKey 或 ollama 本地模型
      // 🔥 用户声明优先（supportsVision），前缀表兜底 —— 新模型（如 ox-alpha）勾选即可用，无需改代码
      const models = userModelRegistry.getAllUserModels(userId);
      const visionModels = models.filter(m => (m.apiKey || m.provider === 'ollama') && (m.supportsVision || isMultimodalModel(m.modelId)));
      if (visionModels.length === 0) {
        return { models: [], hasImageOnlyVision: false };
      }
      if (mediaType === 'video') {
        const videoCapable = visionModels.filter(m => isVideoCapableModel(m.modelId, m.url));
        if (videoCapable.length > 0) {
          return { models: this.prioritizeChatBoundModel(videoCapable, userId), hasImageOnlyVision: false };
        }
        // 有视觉模型但都是图片级，不兜底瞎试（避免 API 报错或幻觉描述）
        return { models: [], hasImageOnlyVision: true };
      }
      return { models: this.prioritizeChatBoundModel(visionModels, userId), hasImageOnlyVision: false };
    } catch (error) {
      console.error('❌ [URL-READER-SERVICE] 查找视觉模型失败:', error);
      return { models: [], hasImageOnlyVision: false };
    }
  }

  /**
   * 🔥 chat 当前绑定的模型优先：用户在对话里选定的模型就是"点名要用"的模型，
   * 若它本身在视觉候选列表里（支持图片理解；视频场景还须支持视频理解），排到首位；
   * 不在列表里（不支持视觉）则不打扰原顺序。首个候选失败仍自动降级到后续候选。
   */
  private prioritizeChatBoundModel(models: SimpleUserModel[], userId: string): SimpleUserModel[] {
    try {
      const boundId =
        modelBindingRegistry.getBinding('organization.execution', userId) ||
        modelBindingRegistry.getBinding('organization.plan', userId) ||
        modelBindingRegistry.getBinding('organization.summary', userId);
      if (!boundId) return models;
      const idx = models.findIndex(m => m.id === boundId);
      if (idx <= 0) return models; // 未绑定 / 不在候选里（不支持视觉）/ 已是首位
      const [bound] = models.splice(idx, 1);
      console.log(`🖼️ [URL-READER-SERVICE] chat 绑定模型 ${bound.name} (${bound.modelId}) 支持视觉，优先使用`);
      return [bound, ...models];
    } catch {
      return models; // 绑定查询失败不影响原候选顺序
    }
  }

  /**
   * 🔥 视觉媒体理解：调用用户配置的视觉模型描述图片/视频内容
   * - 图片：下载转 base64 data URL（兼容不支持 URL 图片的模型，如 Kimi）
   * - 视频：直接传 URL（Qwen-VL / Gemini 支持 video_url content part）
   * - 候选模型逐个尝试：单个模型欠费/失效（429/401/超时等）自动降级到下一个，全部失败才报错
   */
  private async processVisualMedia(
    url: string,
    mediaType: 'image' | 'video',
    userQuery: string | undefined,
    userId: string
  ): Promise<UrlReaderResponse> {
    try {
      console.log(`🖼️ [URL-READER-SERVICE] 开始视觉理解 ${mediaType}: ${url}`);

      const { models: candidates, hasImageOnlyVision } = this.findVisionModels(userId, mediaType);
      if (candidates.length === 0) {
        if (mediaType === 'video') {
          // 有视觉模型但都不支持视频 → 明确指引，不让图片级模型瞎试
          if (hasImageOnlyVision) {
            return {
              success: false,
              url,
              error: '缺少支持视频的视觉模型：已配置的视觉模型仅能理解图片。请告知用户在「模型设置」中添加支持视频的模型（推荐 qwen-vl-max、qwen-vl-plus、gemini-2.5-flash），添加后重新调用本工具即可读取视频'
            };
          }
          // 完全没配视觉模型 → 降级为原有行为（仅返回文件信息）
          return this.processMedia(url, 'video', userQuery);
        }
        return {
          success: false,
          url,
          error: '缺少视觉模型：请告知用户在「模型设置」中添加支持图片理解的模型（推荐 qwen-vl-max、gpt-4o、gemini-2.5-flash），添加后重新调用本工具即可读取图片'
        };
      }

      const mediaLabel = mediaType === 'image' ? '图片' : '视频';
      const textPart = mediaType === 'image'
        ? `请详细描述这张图片的内容，包括其中的文字、图表、界面等关键信息。${userQuery ? `\n用户重点关注：${userQuery}` : ''}`
        : `请详细描述这个视频的内容，包括场景变化、人物动作、出现的文字等，按时间顺序说明。${userQuery ? `\n用户重点关注：${userQuery}` : ''}`;

      const content: ContentPart[] = [{ type: 'text', text: textPart }];

      if (mediaType === 'image') {
        const dataUrl = await this.downloadImageAsDataUrl(url);
        if (!dataUrl) {
          return { success: false, url, error: '图片下载失败或过大（超过20MB），请确认 URL 可访问' };
        }
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      } else {
        // 🔥 本地视频文件无法在线理解（视觉模型按 URL 在线拉取，读不到本地盘）→ 明确引导，不瞎试
        if (this.extractLocalPath(url)) {
          return { success: false, url, error: '本地视频暂不支持直接视觉理解（视觉模型按 URL 在线拉取）。请先用 uploadfiletooss 上传获取 URL，再调用本工具阅读' };
        }
        // 🔥 视频直接传 URL，由视觉模型在线理解
        content.push({ type: 'video_url', video_url: { url } });
      }

      const messages: LLMMessage[] = [{ role: 'user', content }];
      // 🔥 视频理解耗时较长，超时放宽到 120s
      const timeoutMs = mediaType === 'video' ? 120000 : 60000;

      // 🔥 候选模型逐个尝试：单个模型账户问题（429欠费/401失效/超时等）自动降级到下一个
      const failures: string[] = [];
      for (const visionModel of candidates) {
        try {
          console.log(`🖼️ [URL-READER-SERVICE] 使用视觉模型: ${visionModel.name} (${visionModel.modelId})${failures.length > 0 ? `（前 ${failures.length} 个模型失败，自动降级）` : ''}`);
          const response = await llmService.callWithConfig(
            {
              messages,
              temperature: 0.3,
              // 🔥 8000：深度思考模型（如 Seed Pro 2.1）的推理 token 计入 max_output_tokens，
              // 2000 会被思考过程耗尽导致空回复；实际扣费按 usage 计，放大上限无成本副作用
              max_tokens: 8000,
            },
            {
              url: visionModel.url,
              apiKey: visionModel.apiKey,
              model: visionModel.modelId,
              provider: visionModel.provider,
              requestFormat: visionModel.requestFormat,
            },
            timeoutMs
          );

          if (response.success && response.content) {
            return {
              success: true,
              url,
              title: this.getFileNameFromUrl(url),
              content: response.content,
              mediaType,
              metadata: { visionModel: `${visionModel.name} (${visionModel.modelId})` },
              summary: `${mediaLabel}内容已通过视觉模型（${visionModel.name}）理解`
            };
          }

          // 🔥 该模型调用失败 → 记录原因，尝试下一个候选
          const reason = response.error || '未返回内容';
          console.warn(`⚠️ [URL-READER-SERVICE] 视觉模型 ${visionModel.modelId} 调用失败: ${reason}，尝试下一个候选`);
          failures.push(`${visionModel.modelId}: ${String(reason).slice(0, 200)}`);
        } catch (modelError) {
          // 🔥 调用异常（网络超时/连接拒绝等）→ 同样降级到下一个
          const reason = modelError instanceof Error ? modelError.message : '未知错误';
          console.warn(`⚠️ [URL-READER-SERVICE] 视觉模型 ${visionModel.modelId} 调用异常: ${reason}，尝试下一个候选`);
          failures.push(`${visionModel.modelId}: ${reason.slice(0, 200)}`);
        }
      }

      // 🔥 所有候选都失败 → 汇总清单返回，LLM 可据此告知用户具体哪个模型需要充值/检查
      return {
        success: false,
        url,
        error: `所有视觉模型调用失败（共尝试 ${candidates.length} 个）：\n${failures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n请告知用户检查以上模型的账户状态（余额、Key 有效性），修复后重新调用本工具即可`
      };
    } catch (error) {
      const mediaLabel = mediaType === 'image' ? '图片' : '视频';
      console.error(`❌ [URL-READER-SERVICE] ${mediaLabel}视觉理解失败:`, error);
      return {
        success: false,
        url,
        error: `${mediaLabel}视觉理解失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 🔥 识别本地绝对路径（X:\...\xx.png、/abs/path、file://、teegal-file:// 均可）
   * 与 Electron main.ts teegal-file handler 的剥前缀规则保持一致
   */
  private extractLocalPath(url: string): string | null {
    let p = url.trim();
    if (/^(teegal-file|file):\/\//i.test(p)) {
      try { p = decodeURIComponent(p.replace(/^(teegal-file|file):\/\//i, '')); } catch { /* 解码失败保持原样 */ }
      p = p.replace(/^\/+local\//, '').replace(/^\/(?=[a-zA-Z]:)/, '');
    }
    if (/^[a-zA-Z]:[\\/]/.test(p) || /^\/[^/]/.test(p)) return p;
    return null;
  }

  /**
   * 🔥 下载图片并转为 base64 data URL（复用 SummaryModule 的多模态模式）
   * 本地绝对路径直接读盘（截图自证类任务免上传 OSS）：local-backend 跑在用户本机，有文件系统权限
   */
  private async downloadImageAsDataUrl(url: string): Promise<string | null> {
    try {
      // 🔥 本地路径分支：X:\... / /abs / file:// / teegal-file://
      const localPath = this.extractLocalPath(url);
      if (localPath) {
        const buffer = await fs.promises.readFile(localPath);
        if (buffer.length > 20 * 1024 * 1024) {
          console.warn(`⚠️ [URL-READER-SERVICE] 本地图片过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
          return null;
        }
        const extMatch = localPath.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i);
        const EXT_TO_MIME: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
        };
        const mimeType = extMatch ? EXT_TO_MIME[extMatch[1]] : 'image/png';
        console.log(`🖼️ [URL-READER-SERVICE] 本地图片直接读取: ${localPath} (${(buffer.length / 1024).toFixed(0)}KB)`);
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
      }

      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        console.warn(`⚠️ [URL-READER-SERVICE] 图片下载失败: HTTP ${response.status}`);
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 20 * 1024 * 1024) {
        console.warn(`⚠️ [URL-READER-SERVICE] 图片过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
        return null;
      }
      const contentType = response.headers.get('content-type') || '';
      const extMatch = url.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|&|#|$)/i);
      const EXT_TO_MIME: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
      };
      const mimeType = contentType.startsWith('image/')
        ? contentType.split(';')[0]
        : (extMatch ? EXT_TO_MIME[extMatch[1].toLowerCase()] : 'image/jpeg');
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (error) {
      console.warn('⚠️ [URL-READER-SERVICE] 图片下载异常:', error);
      return null;
    }
  }

  private extractYouTubeVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }
}
