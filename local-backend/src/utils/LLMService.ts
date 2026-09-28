/**
 * LLM 统一调用服务
 * 
 * 简化架构：
 * - 配置来源：user-models.json（通过前端 ModelSettings 配置）
 * - 调用方式：callWithConfig(config) 直接使用传入配置
 * - 请求格式：由 config.requestFormat 决定，或自动检测
 */

function cleanMarkdownContent(content: string): string {
  if (!content) return '';
  return content
    .replace(/^```json\s*/g, '')
    .replace(/^```\s*/g, '')
    .replace(/```$/g, '')
    .trim();
}

// 🔥 套餐模型 401 自愈：判断 URL 是否指向云端 llm-proxy + 用 refreshToken 换新
import { isCloudProxyUrl, refreshPackageToken } from './llm/CloudTokenRefresher';

/**
 * 🔥 无法自愈的套餐模型 401（快照缺 refreshToken / refreshToken 已失效 / 续期后仍被拒）：
 * 原始错误对用户是天书（"API 调用失败: 401 令牌无效或已过期"），改成明确处置动作。
 * 原始错误打回后端控制台留痕，不丢诊断信息。
 */
function authExpiredMessage(errorMsg: string, config: LLMConfig): string {
  if (isCloudProxyUrl(config.url) && errorMsg.includes('调用失败: 401 ')) {
    console.warn('⚠️ [LLM-SERVICE] 套餐模型 401 无法自愈（快照缺 refreshToken 或已失效），需用户重新登录:', errorMsg);
    return '云端登录态已过期且无法自动续期，请重新登录账号后再试';
  }
  return errorMsg;
}

export interface LLMConfig {
  url: string;
  apiKey: string;
  /** 🔥 套餐模型专用：云端 refreshToken，401 自愈刷新用（CloudTokenRefresher） */
  refreshToken?: string;
  model: string;
  provider?: string;
  requestFormat?: 'openai' | 'dashscope' | 'responses';
  /** 🔥 用户声明的视觉能力（优先于前缀表推断，如 ox-alpha 等新模型） */
  supportsVision?: boolean;
}

export interface ContentPart {
  type: 'text' | 'image_url' | 'video_url';
  text?: string;
  image_url?: { url: string };
  // 🔥 视频理解（Qwen-VL / Gemini 支持直接传视频 URL）
  video_url?: { url: string };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

export interface LLMResponse {
  success: boolean;
  content?: string;
  reasoningContent?: string;  // 🔥 支持 DeepSeek Reasoner 等模型的 reasoning_content
  error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;  // 🔥 缓存命中的 token 数
    prompt_cache_miss_tokens?: number; // 🔥 缓存未命中的 token 数
    completion_tokens_details?: {      // 🔥 输出 token 明细（含推理 token）
      reasoning_tokens?: number;
      [key: string]: any;
    };
  };
  duration?: number;
}

export class LLMService {
  private static instance: LLMService;

  static getInstance(): LLMService {
    if (!LLMService.instance) {
      LLMService.instance = new LLMService();
    }
    return LLMService.instance;
  }

  /**
   * 使用配置调用 LLM
   */
  async callWithConfig(
    request: LLMRequest,
    config: LLMConfig,
    timeout: number = 30000
  ): Promise<LLMResponse> {
    if (!config.url) {
      return { success: false, error: 'LLM 配置缺少 URL' };
    }

    if (!config.apiKey && config.provider !== 'ollama') {
      return { success: false, error: 'LLM 配置缺少 API Key' };
    }

    const requestFormat = config.requestFormat || this.detectRequestFormat(config);

    const maxRetries = 1;
    const baseDelay = 2000;
    const startTime = Date.now();
    // 🔥 套餐模型 401 自愈：JWT 快照过期 → refreshToken 换新 → 重试一次（每轮调用最多一次）
    let tokenSelfHealed = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let result: LLMResponse;

        if (requestFormat === 'dashscope') {
          result = await this.callDashScope(request, config, timeout);
        } else if (requestFormat === 'responses') {
          result = await this.callResponses(request, config, timeout);
        } else {
          result = await this.callOpenAI(request, config, timeout);
        }

        if (result.success) {
          const duration = Date.now() - startTime;
          return { ...result, duration };
        }

        const errorMsg = result.error || '';

        // 🔥 401 自愈（非抛出路径）：部分格式化调用在内部 catch 后返回 success:false 而非 throw
        if (!tokenSelfHealed && errorMsg.includes('调用失败: 401 ') && config.refreshToken && isCloudProxyUrl(config.url)) {
          tokenSelfHealed = true;
          console.log('🔄 [LLM-SERVICE] 套餐模型 401，尝试自动续期 JWT...');
          const tokens = await refreshPackageToken({ url: config.url, refreshToken: config.refreshToken });
          if (tokens) {
            config.apiKey = tokens.accessToken;
            config.refreshToken = tokens.refreshToken || config.refreshToken;
            attempt--;
            continue;
          }
          console.warn('⚠️ [LLM-SERVICE] 自动续期失败（refreshToken 可能已过期），透传原错误');
        }

        const isOverloaded = errorMsg.includes('429') ||
                           errorMsg.includes('overloaded') ||
                           errorMsg.includes('engine_overloaded_error');

        if (!isOverloaded || attempt === maxRetries) {
          const duration = Date.now() - startTime;
          return { ...result, error: authExpiredMessage(errorMsg, config), duration };
        }

        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`⚠️ [LLM-SERVICE] API 过载 (${attempt}/${maxRetries})，${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // 🔥 套餐模型 401 自愈：云端校验 JWT 失败（快照过期）→ 用 refreshToken 换新 → 更新快照 → 重试
        // （所有格式化调用在 !response.ok 时统一 throw「...调用失败: <status> <body>」）
        if (!tokenSelfHealed && errorMsg.includes('调用失败: 401 ') && config.refreshToken && isCloudProxyUrl(config.url)) {
          tokenSelfHealed = true;
          console.log('🔄 [LLM-SERVICE] 套餐模型 401，尝试自动续期 JWT...');
          const tokens = await refreshPackageToken({ url: config.url, refreshToken: config.refreshToken });
          if (tokens) {
            // 就地更新 config：本次重试 + 同一 callConfig 的后续调用都用新 token
            config.apiKey = tokens.accessToken;
            config.refreshToken = tokens.refreshToken || config.refreshToken;
            attempt--; // 自愈重试不消耗过载重试额度
            continue;
          }
          console.warn('⚠️ [LLM-SERVICE] 自动续期失败（refreshToken 可能已过期），透传原错误');
        }

        const isOverloaded = errorMsg.includes('429') ||
                           errorMsg.includes('overloaded') ||
                           errorMsg.includes('engine_overloaded_error');

        if (!isOverloaded || attempt === maxRetries) {
          const duration = Date.now() - startTime;
          return { success: false, error: authExpiredMessage(errorMsg, config), duration };
        }

        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`⚠️ [LLM-SERVICE] API 异常 (${attempt}/${maxRetries})，${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return { success: false, error: '已达最大重试次数' };
  }

  /**
   * 根据 URL 自动检测请求格式
   */
  private detectRequestFormat(config: LLMConfig): 'openai' | 'dashscope' | 'responses' {
    const url = config.url.toLowerCase();

    // 🔥 方舟 /responses 端点（豆包 Seed 2.x 视频理解必须走此格式，Chat API 会静默忽略视频 part）
    if (url.includes('/responses')) {
      return 'responses';
    }

    if (url.includes('/api/v1/services/aigc/') ||
        url.includes('/multimodal-generation/') ||
        (config.model?.startsWith('farui') && !url.includes('/compatible-mode/'))) {
      return 'dashscope';
    }

    return 'openai';
  }

  /**
   * 🔥 Responses API 调用（方舟 /responses 端点，豆包 Seed 2.x 的视频理解只能走此格式）
   * 客户端全程只认 OpenAI messages 格式，这里做双向转换，所有调用方（Summary/urlread/Reactor）零感知
   */
  private async callResponses(
    request: LLMRequest,
    config: LLMConfig,
    timeout: number
  ): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const { input, instructions } = this.toResponsesInput(request.messages);

      const requestBody: any = {
        model: config.model,
        input,
        // 🔥 Responses 的 max_output_tokens 包含推理 token（Seed 是深度思考模型），过小会空回复
        max_output_tokens: request.max_tokens,
      };
      if (instructions) requestBody.instructions = instructions;
      if (request.temperature !== undefined) requestBody.temperature = request.temperature;
      if (request.response_format) {
        requestBody.text = { format: request.response_format };
      }

      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'teegal/1.0',
          ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ [LLM-SERVICE] Responses API 错误:', {
          url: config.url,
          model: config.model,
          status: response.status,
          errorText: errorText.substring(0, 500),
        });
        throw new Error(`API 调用失败: ${response.status} ${errorText}`);
      }

      const data: any = await response.json();

      // output[]: type=message 的 content[].output_text 拼正文；type=reasoning 的 summary 拼思考摘要
      let content = '';
      let reasoning = '';
      for (const item of data.output || []) {
        if (item.type === 'message') {
          for (const part of item.content || []) {
            if (part.type === 'output_text') content += part.text || '';
          }
        } else if (item.type === 'reasoning') {
          for (const s of item.summary || []) {
            if (typeof s?.text === 'string') reasoning += s.text;
          }
        }
      }

      if (!content) {
        const reason = data.incomplete_details?.reason || data.status || 'unknown';
        return {
          success: false,
          error: `Responses API 空回复 (status=${reason})，深度思考 token 可能耗尽 max_output_tokens，请调大上限`,
        };
      }

      const usage = data.usage ? {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
        completion_tokens_details: data.usage.output_tokens_details,
      } : undefined;

      console.log(`📝 [LLM-SERVICE] Responses 响应: model=${config.model}, contentLength=${content.length}, in=${usage?.prompt_tokens}, out=${usage?.completion_tokens}`);

      return { success: true, content, reasoningContent: reasoning || undefined, usage };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * OpenAI messages → Responses input：system 合并进 instructions，
   * part 映射 text→input_text / image_url→input_image / video_url→input_video（方舟为字符串 URL 字段）
   */
  private toResponsesInput(messages: LLMMessage[]): { input: any[]; instructions?: string } {
    const instructionsParts: string[] = [];
    const input: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        instructionsParts.push(
          typeof msg.content === 'string'
            ? msg.content
            : msg.content.map(p => p.text || '').join('')
        );
        continue;
      }
      const parts = typeof msg.content === 'string'
        ? [{ type: 'input_text', text: msg.content }]
        : msg.content.map(p => {
            // 🔥 方舟 Responses API：video_url/image_url 是裸字符串 URL（object 实测 400 "Mismatch type string"）；
            // sanitizeMediaUrl 剥离 markdown 反引号等脏字符——脏 URL 方舟拉取失败会静默跳过（token 不增、无报错）
            if (p.type === 'video_url') return { type: 'input_video', video_url: this.sanitizeMediaUrl(p.video_url?.url) };
            if (p.type === 'image_url') return { type: 'input_image', image_url: this.sanitizeMediaUrl(p.image_url?.url) };
            return { type: 'input_text', text: p.text || '' };
          });
      input.push({ role: msg.role, content: parts });
    }

    return { input, instructions: instructionsParts.join('\n\n') || undefined };
  }

  /**
   * 🔥 清洗 LLM 抄写的媒体 URL：剥离 markdown 反引号、引号、首尾空白
   * （LLM 从聊天文本里抄 URL 时常带 ` 及换行制表符，直接发给方舟会 400）
   */
  private sanitizeMediaUrl(url?: string): string {
    if (!url) return '';
    return url.trim().replace(/^[\s`'"<(\[]+/, '').replace(/[\s`'"<)\]]+$/, '');
  }

  /**
   * 🔥 检查模型是否只支持 temperature=1
   * Kimi/Moonshot 所有模型都只支持 temperature=1
   */
  private isFixedTemperatureModel(model: string): boolean {
    const modelLower = model?.toLowerCase() || '';

    // 🔥 Kimi/Moonshot 全系列模型（包括 moonshot-v1 和 kimi-k2）
    if (modelLower.includes('kimi') || modelLower.includes('moonshot')) {
      return true;
    }

    return false;
  }
  
  /**
   * 🔥 检查模型是否是 Reasoner 模型（不支持 response_format）
   */
  private isReasonerModel(model: string): boolean {
    const reasonerModels = [
      'deepseek-reasoner',
      'deepseek-r1',
      'deepseek-v4-pro',  // 🔥 添加这个模型
      'deepseek-v4',
    ];
    return reasonerModels.some(m => model?.toLowerCase().includes(m.toLowerCase()));
  }

  /**
   * OpenAI 兼容格式调用
   */
  private async callOpenAI(
    request: LLMRequest,
    config: LLMConfig,
    timeout: number
  ): Promise<LLMResponse> {
    let timeoutId: NodeJS.Timeout | null = null;
    let url = config.url;
    if (!url.includes('/chat/completions') && !url.includes('/api/chat') && !url.includes('/api/generate')) {
      url = url.replace(/\/+$/, '');
      if (url.endsWith('/v1')) {
        url = url + '/chat/completions';
      } else {
        url = url + '/v1/chat/completions';
      }
    }
    
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);

      // 🔥 构建请求体，对固定 temperature 的模型不传递 temperature
      const requestBody: any = {
        model: config.model,
        messages: request.messages,
        max_tokens: request.max_tokens,
      };

      // 只对非固定 temperature 的模型传递 temperature
      if (!this.isFixedTemperatureModel(config.model)) {
        requestBody.temperature = request.temperature ?? 0.7;
      } else {
        console.log(`🔥 [LLM-SERVICE] 模型 ${config.model} 使用固定 temperature，不传递该参数`);
      }

      // 🔥 只对非 Reasoner 模型传递 response_format
      if (!this.isReasonerModel(config.model) && request.response_format) {
        requestBody.response_format = request.response_format;
      } else if (this.isReasonerModel(config.model)) {
        console.log(`🔥 [LLM-SERVICE] 模型 ${config.model} 是 Reasoner 模型，不传递 response_format 参数`);
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'teegal/1.0'
      };

      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      // 🔥 抽取单次调用（用于"思维链耗尽输出预算"时的重试）
      const doCall = async (): Promise<any> => {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ [LLM-SERVICE] OpenAI API 错误:', {
            url: url,
            originalUrl: config.url,
            model: config.model,
            status: response.status,
            statusText: response.statusText,
            errorText: errorText.substring(0, 500)
          });
          throw new Error(`API 调用失败: ${response.status} ${errorText}`);
        }

        return response.json();
      };

      let data: any = await doCall();
      let content = data.choices?.[0]?.message?.content;
      let reasoningContent = data.choices?.[0]?.message?.reasoning_content;

      // 🔥 思考模型可能把输出预算（max_tokens 为思维链+正文共享）全部耗在思维链上：
      //    finish_reason=length、reasoning_content 很长、content 为空。
      //    此时去掉 max_tokens 限制并追加收敛提示后重试一次，避免下游拿到空内容直接失败。
      if ((!content || content.trim() === '') && reasoningContent && requestBody.max_tokens) {
        console.warn(`⚠️ [LLM-SERVICE] 思维链耗尽输出预算（finish_reason=${data.choices?.[0]?.finish_reason}, reasoning ${reasoningContent.length} 字符），去除 max_tokens 并追加提示后重试`);
        delete requestBody.max_tokens;

        // 🔥 在最后一条消息末尾追加轻量提示（追加在末尾不影响 prompt 前缀缓存；
        //    拷贝消息对象，避免突变调用方数据）
        const RETRY_HINT = '【系统提示】上一次生成因思考链过长被截断，未能输出正式回答。请大幅精简思考过程，直接给出最终回答。';
        const msgs: any[] = [...(requestBody.messages || [])];
        const lastIdx = msgs.length - 1;
        const lastMsg = msgs[lastIdx];
        if (lastMsg) {
          if (typeof lastMsg.content === 'string') {
            msgs[lastIdx] = { ...lastMsg, content: `${lastMsg.content}\n\n${RETRY_HINT}` };
          } else if (Array.isArray(lastMsg.content)) {
            msgs[lastIdx] = { ...lastMsg, content: [...lastMsg.content, { type: 'text', text: RETRY_HINT }] };
          }
          requestBody.messages = msgs;
        }

        data = await doCall();
        content = data.choices?.[0]?.message?.content;
        reasoningContent = data.choices?.[0]?.message?.reasoning_content || reasoningContent;
      }

      const finishReason = data.choices?.[0]?.finish_reason;
      const completionTokens = data.usage?.completion_tokens;
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

      // 🔥 如果 content 为空，尝试其他字段
      if (!content && data.message?.content) {
        content = data.message.content;
      }
      if (!content && data.content) {
        content = data.content;
      }

      if (!content && !reasoningContent) {
        if (data.choices?.[0]?.message?.refusal) {
          throw new Error(`模型拒绝回答: ${data.choices[0].message.refusal}`);
        }
        throw new Error('返回内容为空');
      }

      // 🔥 记录原始内容（用于调试）
      console.log('📝 [LLM-SERVICE] 原始响应内容:', {
        model: config.model,
        finishReason,
        completionTokens,
        contentLength: content?.length || 0,
        contentPreview: content?.substring(0, 500),
        hasReasoningContent: !!reasoningContent,
        reasoningContentLength: reasoningContent?.length || 0,
      });

      let cleanedContent = cleanMarkdownContent(content || '');

      // 🔥 从 content 中提取 <think> 标签内容作为 reasoningContent（如果 API 没提供）
      const thinkMatch = cleanedContent.match(/<think>([\s\S]*?)<\/think>/);
      const thinkingMatch = cleanedContent.match(/<thinking>([\s\S]*?)<\/thinking>/);
      const extractedReasoning = thinkMatch?.[1] || thinkingMatch?.[1];
      
      // 如果 API 返回了 reasoning_content，优先使用；否则使用从 content 提取的
      const finalReasoningContent = reasoningContent || extractedReasoning;

      // 🔥 清理 content 中的 <think> 标签
      if (thinkMatch || thinkingMatch) {
        cleanedContent = cleanedContent
          .replace(/<think>[\s\S]*?<\/think>/, '')
          .replace(/<thinking>[\s\S]*?<\/thinking>/, '')
          .trim();
      }

      // 🔥 提取 JSON 内容（处理模型返回的 markdown 代码块等）
      // 优先匹配 ```json 代码块（非贪婪匹配，确保只匹配到第一个 ```json...```）
      let jsonMatch = cleanedContent.match(/```json\s*([\s\S]*?)```/);
      
      // 其次匹配 ``` 代码块，但要确保内容是 JSON 格式（以 { 或 [ 开头）
      if (!jsonMatch) {
        const codeBlockMatch = cleanedContent.match(/```\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          const blockContent = codeBlockMatch[1]?.trim() || '';
          // 只当代码块内容是 JSON 格式时才使用
          if (blockContent.startsWith('{') || blockContent.startsWith('[')) {
            jsonMatch = codeBlockMatch;
          }
        }
      }
      
      // 最后尝试匹配 JSON 对象（从第一个 { 到最后一个 }）
      if (!jsonMatch) {
        const firstBrace = cleanedContent.indexOf('{');
        const lastBrace = cleanedContent.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          jsonMatch = [cleanedContent.substring(firstBrace, lastBrace + 1)];
        }
      }
      
      if (jsonMatch) {
        cleanedContent = jsonMatch[1] || jsonMatch[0];
      }

      return { success: true, content: cleanedContent.trim(), reasoningContent: finalReasoningContent, usage: {
        prompt_tokens: data.usage?.prompt_tokens || 0,
        completion_tokens: data.usage?.completion_tokens || 0,
        total_tokens: data.usage?.total_tokens || 0,
        prompt_cache_hit_tokens: data.usage?.prompt_cache_hit_tokens || data.usage?.prompt_tokens_details?.cached_tokens || 0,
        prompt_cache_miss_tokens: data.usage?.prompt_cache_miss_tokens || 0,
        completion_tokens_details: data.usage?.completion_tokens_details, // 🔥 透传推理 token 明细
      } };

    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('aborted');
      
      // 🔥 处理 DeepSeek 内容安全审查错误
      if (errorMessage.includes('Content Exists Risk')) {
        console.warn('⚠️ [LLM-SERVICE] 内容触发安全审查:', errorMessage);
        return {
          success: true,
          content: JSON.stringify({
            say_to_user: '内容涉及敏感或争议话题，AI 服务拒绝返回结果。请尝试调整查询内容。'
          }),
          reasoningContent: '',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
      }
      
      console.error('❌ [LLM-SERVICE] OpenAI 格式调用失败:', {
        url: url,
        originalUrl: config.url,
        model: config.model,
        error: errorMessage,
        isTimeout: isAbortError
      });
      
      return {
        success: false,
        error: isAbortError ? `请求超时 (${timeout}ms)` : errorMessage
      };
    }
  }

  /**
   * DashScope 格式调用（用于 Farui 等模型）
   */
  private async callDashScope(
    request: LLMRequest,
    config: LLMConfig,
    timeout: number
  ): Promise<LLMResponse> {
    let timeoutId: NodeJS.Timeout | null = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${config.apiKey}`,
          'User-Agent': 'teegal/1.0'
        },
        body: JSON.stringify({
          model: config.model,
          input: { messages: request.messages },
          parameters: { result_format: 'message' }
        }),
        signal: controller.signal
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ [LLM-SERVICE] DashScope API 错误:', {
          url: config.url,
          model: config.model,
          status: response.status,
          statusText: response.statusText,
          errorText: errorText.substring(0, 500)
        });
        throw new Error(`DashScope API 调用失败: ${response.status} ${errorText}`);
      }

      const data: any = await response.json();
      let content = data.output?.text || data.output?.choices?.[0]?.message?.content;

      if (!content) {
        if (data.output?.choices?.[0]?.message?.refusal) {
          throw new Error(`模型拒绝回答: ${data.output.choices[0].message.refusal}`);
        }
        throw new Error('返回内容为空');
      }

      // 🔥 记录原始内容（用于调试）
      console.log('📝 [LLM-SERVICE] DashScope 原始响应内容:', {
        model: config.model,
        contentLength: content?.length || 0,
        contentPreview: content?.substring(0, 500),
      });

      const cleanedContent = cleanMarkdownContent(content);
      return { success: true, content: cleanedContent, usage: {
        prompt_tokens: data.usage?.prompt_tokens || 0,
        completion_tokens: data.usage?.completion_tokens || 0,
        total_tokens: data.usage?.total_tokens || 0,
        prompt_cache_hit_tokens: data.usage?.prompt_cache_hit_tokens || data.usage?.prompt_tokens_details?.cached_tokens || 0,
        prompt_cache_miss_tokens: data.usage?.prompt_cache_miss_tokens || 0,
        completion_tokens_details: data.usage?.completion_tokens_details, // 🔥 透传推理 token 明细
      } };

    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('aborted');
      
      // 🔥 处理内容安全审查错误
      if (errorMessage.includes('Content Exists Risk')) {
        console.warn('⚠️ [LLM-SERVICE] 内容触发安全审查:', errorMessage);
        return {
          success: true,
          content: JSON.stringify({
            say_to_user: '内容涉及敏感或争议话题，AI 服务拒绝返回结果。请尝试调整查询内容。'
          }),
          reasoningContent: '',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
      }
      
      console.error('❌ [LLM-SERVICE] DashScope 格式调用失败:', {
        url: config.url,
        model: config.model,
        error: errorMessage,
        isTimeout: isAbortError
      });
      
      return {
        success: false,
        error: isAbortError ? `请求超时 (${timeout}ms)` : errorMessage
      };
    }
  }
}

export const llmService = LLMService.getInstance();
