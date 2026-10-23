/**
 * URL Reader 工具 - 简化版
 * 爬取 URL 内容并生成 Markdown 文件供 LLM 分析
 */

import { AutoStep, AutoToolResult } from '@/utils/auto/types';
import { ToolApiClient } from '@/utils/ToolApiClient';

// ============================================================================
// 🔥 错误消息管理模块
// ============================================================================

interface ErrorMessage {
  title: string;
  reason?: string;
  suggestion: string;
  examples?: string[];
}

const ErrorMessages = {
  // 参数相关错误
  MISSING_URL: (): ErrorMessage => ({
    title: '❌ 缺少 URL 参数',
    reason: '未提供有效的 URL 链接',
    suggestion: '请提供要爬取的网页 URL',
    examples: [
      '{ "url": "https://example.com/article" }',
      '{ "query": "请分析 https://example.com 的内容" }'
    ]
  }),

  INVALID_URL: (url: string): ErrorMessage => ({
    title: '❌ URL 格式无效',
    reason: `提供的 "${url}" 不是有效的 URL 格式`,
    suggestion: '请提供完整的 HTTP 或 HTTPS URL',
    examples: [
      '✅ 正确: https://www.example.com',
      '✅ 正确: http://localhost:8080',
      '❌ 错误: www.example.com (缺少协议头)'
    ]
  }),

  // 网络/爬取错误
  ANTI_SCRAPING: (url: string): ErrorMessage => ({
    title: '🛡️ 网站阻止了爬取',
    reason: `目标网站 "${url}" 启用了反爬机制、访问超时或拒绝了自动化请求`,
    suggestion: '该网站无法直接爬取，请尝试其他方式获取信息，或基于已有知识继续任务',
    examples: [
      '🌐 直接访问网站手动查看内容',
      '🔍 使用搜索引擎查找相关信息',
      '📚 使用官方 API 获取数据（如有）',
      '💡 基于已有信息继续任务（推荐）'
    ]
  }),

  RATE_LIMITED: (url: string): ErrorMessage => ({
    title: '🚦 网站限流 (429)',
    reason: `目标网站 "${url}" 返回 429 错误，请求过于频繁或需要身份验证`,
    suggestion: '网站限制了自动化访问，建议使用搜索引擎获取信息',
    examples: [
      '🔍 使用搜索引擎搜索该网站内容',
      '📖 查看搜索引擎缓存版本',
      '🌐 手动访问网站查看',
      '💡 基于已有搜索结果继续任务（推荐）'
    ]
  }),

  ACCESS_DENIED: (url: string): ErrorMessage => ({
    title: '🚫 访问被拒绝 (403)',
    reason: `目标网站 "${url}" 返回 403 错误，禁止访问该资源`,
    suggestion: '网站禁止了自动化访问，建议使用其他方式获取信息',
    examples: [
      '🔍 使用搜索引擎搜索相关内容',
      '📖 查看搜索引擎缓存版本',
      '💡 基于已有信息继续任务（推荐）'
    ]
  }),

  NOT_FOUND: (url: string): ErrorMessage => ({
    title: '❓ 页面不存在 (404)',
    reason: `目标 URL "${url}" 返回 404 错误，页面可能已被删除或移动`,
    suggestion: '请检查 URL 是否正确，或搜索相关内容',
    examples: [
      '检查 URL 拼写是否正确',
      '🔍 使用搜索引擎搜索相关内容',
      '访问网站首页查找目标页面'
    ]
  }),

  TIMEOUT: (url: string): ErrorMessage => ({
    title: '⏱️ 请求超时',
    reason: `访问 "${url}" 超时，网站响应过慢或无法访问`,
    suggestion: '请检查 URL 是否正确，或稍后重试',
    examples: [
      '检查 URL 拼写是否正确',
      '确认网站是否可访问',
      '尝试访问其他镜像站点',
      '基于已有信息继续任务'
    ]
  }),

  NETWORK_ERROR: (error: string): ErrorMessage => ({
    title: '❌ 网络请求失败',
    reason: `请求过程中发生错误: ${error}`,
    suggestion: '请检查网络连接或稍后重试',
    examples: [
      '检查网络连接',
      '确认目标网站可访问',
      '稍后重试',
      '使用其他信息源'
    ]
  }),

  API_KEY_MISSING: (): ErrorMessage => ({
    title: '🔑 缺少 API Key',
    reason: '未配置 URL 读取服务的 API Key（Firecrawl/Jina）',
    suggestion: '请在设置中配置 Firecrawl 或 Jina 的 API Key 以提高爬取成功率',
    examples: [
      '前往设置 → 模型配置 → 添加 Firecrawl API Key',
      '或添加 Jina AI Reader API Key',
      '💡 暂时使用搜索引擎获取信息（推荐）'
    ]
  }),

  // 内容解析错误
  PARSE_FAILED: (url: string): ErrorMessage => ({
    title: '❌ 内容解析失败',
    reason: `无法从 "${url}" 提取有效内容`,
    suggestion: '网页可能使用了特殊的渲染技术或需要登录',
    examples: [
      '尝试访问网站的简化版本',
      '使用搜索引擎缓存版本',
      '查找其他来源的相同信息'
    ]
  }),

  MEDIA_NEEDS_INSTRUCTION: (url: string): ErrorMessage => ({
    title: '🖼️ 媒体链接需要阅读指令',
    reason: `URL "${url}" 指向图片/视频/音频等媒体文件。不带 instruction 时只会原始下载字节流（JFIF/Exif 二进制乱码），无法理解画面内容`,
    suggestion: '重新调用并带上 instruction 写明想了解什么，即可调用视觉模型真正"看图"',
    examples: [
      '{ "url": "https://...jpg", "instruction": "描述这张图片的内容" }',
      '{ "url": "https://...mp4", "instruction": "视频里发生了什么" }'
    ]
  }),

  // 🔥 本地路径但不是图片：web_url_reader 只对本地图片做视觉理解（后端读盘），其余文件走专门工具
  LOCAL_PATH_NOT_IMAGE: (url: string): ErrorMessage => ({
    title: '📁 本地文件不支持直接阅读',
    reason: `路径 "${url}" 是本地文件但不是图片。web_url_reader 对本地文件仅支持图片视觉理解`,
    suggestion: '按文件类型换用专门工具',
    examples: [
      '项目内文件: read_project_file（文本）或 teegal_file_analyze_toabstract（分析）',
      '本地图片: 直接传图片完整路径（如 C:\\shot.png）+ instruction 即可视觉理解',
      '需要 URL 交付: uploadfiletooss 上传后用返回的 URL 调用本工具'
    ]
  }),

  // 使用指南
  USAGE_GUIDE: (): ErrorMessage => ({
    title: '📖 URL Reader 使用指南',
    suggestion: '这是一个网页内容爬取工具，用于获取网页文本内容',
    examples: [
      '爬取: { "url": "https://example.com/article" }',
      '查询: { "query": "分析 https://example.com 的内容" }',
      '注意: 部分网站有反爬机制，可能无法访问'
    ]
  })
};

/**
 * 格式化错误消息为字符串
 */
function formatErrorMessage(error: ErrorMessage): string {
  let message = error.title;

  if (error.reason) {
    message += `\n\n【问题】${error.reason}`;
  }

  message += `\n\n【建议】${error.suggestion}`;

  if (error.examples && error.examples.length > 0) {
    message += '\n\n【示例】';
    error.examples.forEach((example, index) => {
      message += `\n${index + 1}. ${example}`;
    });
  }

  return message;
}

// ============================================================================

export interface UrlReaderRequest {
  url: string;
  userQuery?: string;
  userId: string;
  conversationId: string;
}

/**
 * 🔥 从文本中提取 URL
 */
function extractUrlFromText(text: string): string | null {
  const urlRegex = /(https?:\/\/[^\s<>"{}|\^`\[\]]+)/i;
  const match = text.match(urlRegex);
  return match ? match[1] : null;
}

/**
 * 🔥 检查 URL 是否是 OSS 内容 URL
 * OSS URL 通常包含特定的域名模式或路径特征
 */
function isOssContentUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  
  // 常见的 OSS 域名特征
  const ossPatterns = [
    // 阿里云 OSS
    /\.oss-[\w-]+\.aliyuncs\.com/i,
    /\.oss\.aliyuncs\.com/i,
    // AWS S3
    /\.s3[\w-]*\.amazonaws\.com/i,
    /s3:\/\//i,
    // 腾讯云 COS
    /\.cos\.[\w-]+\.myqcloud\.com/i,
    // 七牛云
    /\.qiniudn\.com/i,
    /\.qiniu\.com/i,
    // 又拍云
    /\.upaiyun\.com/i,
    // 华为云 OBS
    /\.obs\.[\w-]+\.myhuaweicloud\.com/i,
    // 百度云 BOS
    /\.bcebos\.com/i,
    // 通用 OSS 路径特征
    /\/oss\//i,
    /\/storage\//i,
    /\/files\//i,
    // 文件扩展名（直接链接到文件）
    /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|zip|rar|7z|tar|gz)(\?|$)/i
  ];
  
  return ossPatterns.some(pattern => pattern.test(lowerUrl));
}

/**
 * 🔥 执行 URL Reader 工具
 * 简化逻辑：调用后端 API 爬取内容，返回 Markdown 格式结果
 */
export async function executeUrlReaderTool(
  step: AutoStep,
  planId: string,
  userId: string,
  conversationId: string
): Promise<AutoToolResult> {
  console.log('🔗 [URL-READER-TOOL] 开始处理 URL');

  // 🔥 在 try 外部定义 url，以便 catch 块也能访问
  let url = '';

  try {
    const params = step.toolParams || {};

    // 🔥 提取 URL（支持 url 或 query 参数）
    // LLM 习惯用反引号包裹 URL（markdown 惯性），且上传文件段格式为「URL: `url`]」，
    // LLM 抄 URL 时常把闭合的 ] ） 一起带上 → 媒体扩展名判断失效（.mp4] ≠ .mp4），
    // 会被误判成"OSS 文件 URL"拦截。这里统一剥掉反引号/引号/闭合括号
    url = String(params.url || '').replace(/^[`"'\])]+|[`"'\])]+$/g, '').trim();
    if (!url && params.query) {
      url = extractUrlFromText(params.query) || '';
    }
    if (!url) {
      const textToSearch = step.description || '';
      url = extractUrlFromText(textToSearch) || '';
    }

    // 🔥 instruction：agent 自行拟定的阅读关注指令（如查看自产视频的转场效果），并非用户原话
    const userQuery = params.instruction || params.userQuery || step.description || '';

    if (!url) {
      const error = ErrorMessages.MISSING_URL();
      return {
        success: false,
        error: formatErrorMessage(error),
        metadata: { toolName: 'url_reader' },
      };
    }

    // 🔥 验证 URL 格式：http(s) 或本地图片路径（图片走后端直接读盘视觉理解，截图自证免上传 OSS）。
    // 本地音视频不支持（视觉模型按 URL 在线拉取读不到本地盘），其他本地文件引导用专门工具
    const looksLocalPath = /^[a-zA-Z]:[\\/]/.test(url) || /^\/[^/]/.test(url) || /^(file|teegal-file):\/\//i.test(url);
    if (looksLocalPath) {
      if (!/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url)) {
        const error = ErrorMessages.LOCAL_PATH_NOT_IMAGE(url);
        return {
          success: false,
          error: formatErrorMessage(error),
          metadata: { toolName: 'url_reader' },
        };
      }
    } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
      const error = ErrorMessages.INVALID_URL(url);
      return {
        success: false,
        error: formatErrorMessage(error),
        metadata: { toolName: 'url_reader' },
      };
    }

    // 🔥 媒体 URL（图片/视频/音频）必须带阅读指令：不传时后端只会原始下载字节流当文本吐回（乱码）。
    // 这里提前拦截并指引 LLM 带上 instruction 走视觉模型，而不是让它拿到一堆二进制乱码再猜
    const isMediaUrl = /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|mov|avi|mkv|mp3|wav|ogg|m4a|flac|aac)(\?|&|#|$)/i.test(url);
    if (isMediaUrl && !userQuery.trim()) {
      const error = ErrorMessages.MEDIA_NEEDS_INSTRUCTION(url);
      return {
        success: false,
        error: formatErrorMessage(error),
        metadata: { toolName: 'url_reader', url },
      };
    }

    // 🔥 检查是否是 OSS 内容 URL（图片/视频除外——它们走后端视觉模型理解，不受此拦截）
    if (isOssContentUrl(url) && !isMediaUrl) {
      const error: ErrorMessage = {
        title: '❌ 检测到 OSS 文件 URL',
        reason: `URL "${url}" 指向一个 OSS 存储的文件`,
        suggestion: '如需解读文件内容生成摘要，请使用 teegal_file_analyze_toabstract 工具进行文件分析',
        examples: [
          '使用 teegal_file_analyze_toabstract 工具传入该 URL',
          '或者下载文件后上传到对话中进行分析'
        ]
      };
      return {
        success: false,
        error: formatErrorMessage(error),
        metadata: { toolName: 'url_reader', url },
      };
    }

    console.log('🔗 [URL-READER-TOOL] 处理 URL:', { url, userQuery });

    // 🔥 调用后端 API 爬取内容
    const response: any = await ToolApiClient.urlReader.process({
      url,
      userQuery,
      userId,
      conversationId,
    });

    if (!response.success) {
      // 🔥 视觉模型相关错误由后端给出明确指引，直接透传，避免被误分类为网络错误
      if ((response.error || '').includes('视觉模型')) {
        return {
          success: false,
          error: response.error,
          metadata: { toolName: 'url_reader', url },
        };
      }

      // 🔥 分析错误类型并给出友好提示
      const errorStr = (response.error || '').toLowerCase();
      let error: ErrorMessage;

      if (errorStr.includes('etimedout') || errorStr.includes('timeout') || errorStr.includes('超时')) {
        error = ErrorMessages.TIMEOUT(url);
      } else if (errorStr.includes('反爬') || errorStr.includes('anti') || errorStr.includes('blocked') ||
                 errorStr.includes('forbidden') || errorStr.includes('403') || errorStr.includes('429')) {
        error = ErrorMessages.ANTI_SCRAPING(url);
      } else if (errorStr.includes('所有爬取方式均失败') || errorStr.includes('failed')) {
        error = ErrorMessages.ANTI_SCRAPING(url);
      } else {
        error = ErrorMessages.NETWORK_ERROR(response.error || '未知错误');
      }

      return {
        success: false,
        error: formatErrorMessage(error),
        metadata: { toolName: 'url_reader', url },
      };
    }

    console.log('✅ [URL-READER-TOOL] 内容爬取完成:', {
      title: response.title,
      contentLength: response.content?.length || 0,
    });

    // 🔥 构建 Markdown 内容
    const markdownContent = buildMarkdownContent(response, userQuery);

    return {
      success: true,
      data: {
        url: response.url,
        title: response.title,
        content: response.content,
        summary: response.summary || response.llmSummary,
        mediaType: response.mediaType,
        markdown: markdownContent,
      },
      metadata: {
        toolName: 'url_reader',
        url: response.url,
        title: response.title,
        mediaType: response.mediaType,
      },
    };
  } catch (error) {
    console.error('❌ [URL-READER-TOOL] 执行失败:', error);
    const errorMsg = error instanceof Error ? error.message : 'URL Reader 工具执行失败';

    // 🔥 视觉模型相关错误：后端 500 时 ToolApiClient 直接 throw（不走上面的 response.success 分支），
    // 必须在这里提取 JSON 里的后端原始指引透传给 LLM，否则会被误分类成"网站阻止了爬取"
    if (errorMsg.includes('视觉模型')) {
      let visionError = errorMsg;
      const jsonStart = errorMsg.indexOf('{');
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(errorMsg.substring(jsonStart));
          if (parsed.error) visionError = parsed.error;
        } catch {
          const match = errorMsg.match(/"error"\s*:\s*"([^"]+)"/);
          if (match) visionError = match[1];
        }
      }
      return {
        success: false,
        error: visionError,
        metadata: { toolName: 'url_reader', url },
      };
    }

    // 🔥 智能错误分类系统
    const errorStr = errorMsg.toLowerCase();
    let errorObj: ErrorMessage;

    // 1. API Key 相关错误
    if (errorStr.includes('api key') || errorStr.includes('apikey') || 
        errorStr.includes('未配置') || errorStr.includes('未初始化')) {
      errorObj = ErrorMessages.API_KEY_MISSING();
    }
    // 2. HTTP 状态码错误
    else if (errorStr.includes('429') || errorStr.includes('too many requests') || 
             errorStr.includes('rate limit') || errorStr.includes('限流')) {
      errorObj = ErrorMessages.RATE_LIMITED(url);
    }
    else if (errorStr.includes('403') || errorStr.includes('forbidden') || 
             errorStr.includes('access denied') || errorStr.includes('禁止访问')) {
      errorObj = ErrorMessages.ACCESS_DENIED(url);
    }
    else if (errorStr.includes('404') || errorStr.includes('not found')) {
      errorObj = ErrorMessages.NOT_FOUND(url);
    }
    // 3. 反爬/拦截错误
    else if (errorStr.includes('所有爬取方式均失败') || 
             errorStr.includes('反爬') || errorStr.includes('anti') || 
             errorStr.includes('blocked') || errorStr.includes('captcha') ||
             errorStr.includes('cloudflare') || errorStr.includes('验证')) {
      errorObj = ErrorMessages.ANTI_SCRAPING(url);
    }
    // 4. 超时错误
    else if (errorStr.includes('etimedout') || errorStr.includes('timeout') || 
             errorStr.includes('超时') || errorStr.includes('socket hang up')) {
      errorObj = ErrorMessages.TIMEOUT(url);
    }
    // 5. 网络/DNS 错误
    else if (errorStr.includes('enotfound') || errorStr.includes('econnrefused') || 
             errorStr.includes('dns') || errorStr.includes('network') ||
             errorStr.includes('unreachable')) {
      errorObj = ErrorMessages.NETWORK_ERROR(errorMsg);
    }
    // 6. 默认错误
    else {
      errorObj = ErrorMessages.ANTI_SCRAPING(url);
    }

    return {
      success: false,
      error: formatErrorMessage(errorObj),
      metadata: {
        toolName: 'url_reader',
        url: url,
        errorType: errorObj.title.split(' ')[0], // 提取错误类型标识
      },
    };
  }
}

/**
 * 🔥 构建 Markdown 格式的内容
 */
function buildMarkdownContent(response: any, userQuery: string): string {
  const lines: string[] = [];

  // 标题
  lines.push(`# ${response.title || 'URL 内容分析'}`);
  lines.push('');

  // 元信息
  lines.push('## 基本信息');
  lines.push('');
  lines.push(`- **URL**: ${response.url}`);
  lines.push(`- **媒体类型**: ${response.mediaType || 'web'}`);
  if (response.metadata?.author) {
    lines.push(`- **作者**: ${response.metadata.author}`);
  }
  if (response.metadata?.publishedDate) {
    lines.push(`- **发布日期**: ${response.metadata.publishedDate}`);
  }
  lines.push('');

  // 用户查询
  if (userQuery) {
    lines.push('## 用户问题');
    lines.push('');
    lines.push(userQuery);
    lines.push('');
  }

  // LLM 总结
  if (response.llmSummary || response.summary) {
    lines.push('## 内容总结');
    lines.push('');
    lines.push(response.llmSummary || response.summary);
    lines.push('');
  }

  // 原始内容
  if (response.content) {
    lines.push('## 原始内容');
    lines.push('');
    lines.push(response.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 执行工具（供 ToolHandler 调用）
 */
export async function executeUrlReaderToolWrapper(
  step: AutoStep,
  planId: string,
  userId: string,
  conversationId: string
): Promise<AutoToolResult> {
  return executeUrlReaderTool(step, planId, userId, conversationId);
}
