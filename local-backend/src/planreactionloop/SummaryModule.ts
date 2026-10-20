/**
 * ECS Async Worker: SummaryModule
 * 
 * 职责：
 * 1. 总结 (Summary) - 统一处理用户需求（初始分析 + 调查后分析）
 * 2. 检查 (Review) - 执行结果检查
 */

import { llmService, LLMConfig, LLMMessage, ContentPart } from '../utils/LLMService';
import { SummaryProtocols } from './protocols';
import { safeJSONParse, unescapeJSONString, findBalancedEnd, extractJSONObjects, normalizeToolAliases, salvageToolsFromText } from './utils/JSONParser';
import { tokenUsageService } from '../utils/TokenUsageService';
// 🔥 视觉模型注册表：前后端唯一维护点在 shared/visionModels.ts
// （旧 MULTIMODAL_MODEL_PREFIXES/EXACT 与前端两套表已合并，消除双维护）
import { detectVisionByModelId as isMultimodalModel, isVideoCapableModel } from '../shared/visionModels';

// 🔥 session 动作白名单（与 SummaryProtocols tools 语法一致）：意图闸门的边界条件——
// 原文含白名单名但结构化解析失败才抢救；连名都没有 = LLM 本来就没派活，该丢就丢
const SESSION_ACTION_NAMES = ['sessioncreate', 'getContext', 'killsession', 'check_update'];
const SESSION_ACTION_RE = new RegExp(SESSION_ACTION_NAMES.join('|'));

/**
 * 🔥 从 userQuery 部分提取用户主动上传的图片 URL，构建多模态消息
 *
 * 规则：
 * 1. 只从 userQuery（## 当前用户qurey 段落）中提取，不从 conversationHistory 等提取
 * 2. 只匹配 "--- 已上传文件 ---" 标记后的图片 URL（用户真实意愿）
 * 3. 只在第一轮（depth=0）传图片，后续轮次不重复传
 * 4. 只对支持多模态的模型传图片，不支持的不传（避免 API 报错）
 *
 * 注意：Kimi 等模型不支持 URL 格式图片，只支持 base64 编码
 * 所以需要下载图片 → 转 base64 → 构造 data:image/xxx;base64,... 格式
 */
async function buildMultimodalContent(
  text: string,
  currentDepth: number,
  modelId: string,
  /** 🔥 用户声明的视觉能力（优先于前缀表推断，如 ox-alpha 等新模型） */
  supportsVision?: boolean,
  /** 🔥 模型请求端点：doubao-seed-2 只有 /responses 端点才算视频可用 */
  modelUrl?: string
): Promise<string | ContentPart[]> {
  // 🔥 条件2：只在第一轮传图片
  if (currentDepth > 1) {
    return text;
  }

  // 🔥 条件4：模型必须支持多模态（用户声明 || 前缀表）
  if (!(supportsVision || isMultimodalModel(modelId))) {
    return text;
  }

  const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/i;
  const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv|flv)(\?|$)/i;
  const EXT_TO_MIME: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  };

  // 🔥 条件1：只从 userQuery 段落提取（## 当前用户qurey 开始到下一个 ## 段落）
  const userQueryMatch = text.match(/## 当前用户qurey\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!userQueryMatch) {
    return text; // 没有用户查询段落
  }
  const userQueryText = userQueryMatch[1];

  // 🔥 条件2：只匹配 "--- 已上传文件 ---" 标记后的图片 URL
  const uploadSectionMatch = userQueryText.match(/---\s*已上传文件\s*---([\s\S]*)/);
  if (!uploadSectionMatch) {
    return text; // 没有用户主动上传的文件
  }
  const uploadSection = uploadSectionMatch[1];

  // 从上传段落中提取图片 / 视频 URL
  const urlRegex = /URL:\s*`?(https?:\/\/[^\s\]`]+)/g;
  const imageUrls: { url: string; ext: string }[] = [];
  const videoUrls: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(uploadSection)) !== null) {
    const url = match[1];
    const extMatch = url.match(IMAGE_EXTENSIONS);
    if (extMatch) {
      imageUrls.push({ url, ext: extMatch[1].toLowerCase() });
      continue;
    }
    if (VIDEO_EXTENSIONS.test(url)) {
      videoUrls.push(url);
    }
  }

  console.log(`🖼️ [SummaryModule] 多模态内容: 图片=${imageUrls.length}, 视频=${videoUrls.length}`);

  if (imageUrls.length === 0 && videoUrls.length === 0) {
    return text; // 无图片无视频，返回纯文本
  }

  // 构建多模态内容：文本 + 图片（base64）+ 视频（URL 直传）
  const parts: ContentPart[] = [
    { type: 'text', text }
  ];

  for (const { url, ext } of imageUrls) {
    try {
      // 下载图片并转为 base64
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        console.warn(`🖼️ [SummaryModule] 下载图片失败: ${url}, status=${response.status}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      const mimeType = EXT_TO_MIME[ext] || 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${base64}`;

      parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    } catch (err) {
      console.warn(`🖼️ [SummaryModule] 图片处理失败: ${url}`, err instanceof Error ? err.message : err);
      // 跳过失败的图片，不阻塞整个请求
    }
  }

  // 🔥 视频直传 URL（与视觉管线同款 video_url part）：视频文件大（几十 MB+），不能像图片那样
  // 下载转 base64；qwen-vl / gemini（Chat video_url）与 doubao-seed-2（/responses 端点）都支持 URL 直读。
  // 当前模型不支持视频理解时不硬塞（避免 API 报错），保持纯文本交由 Reactor 走 web_url_reader 视觉管线降级
  if (videoUrls.length > 0) {
    if (isVideoCapableModel(modelId, modelUrl)) {
      for (const url of videoUrls) {
        parts.push({ type: 'video_url', video_url: { url } });
      }
    } else {
      console.log(`🎬 [SummaryModule] 检测到视频但当前模型 ${modelId} 不支持视频理解，交由 urlread 工具处理`);
    }
  }

  // 如果没有任何媒体部件（图片全失败 / 模型不支持视频），返回纯文本
  if (parts.length === 1) {
    return text;
  }

  return parts;
}

/**
 * 🔥 统一总结请求
 */
export interface SummaryRequest {
  /**
   * 🔥 前端构建的环境文本（包含 userQuery、files、conversationHistory 等）
   */
  environmentText: string;
  /**
   * 🔥 工具执行结果（用于递归 gather）
   */
  toolResults?: Array<{
    toolName: string;
    parameters: any;
    result: any;
  }>;
  /**
   * 🔥 当前递归深度（从0开始，0表示初始接待）
   */
  currentDepth?: number;
  /**
   * 🔥 最大递归深度
   */
  maxDepth?: number;
  /**
   * 🔥 工作笔记，防止遗忘
   */
  writeNotes?: string;
  /**
   * 🔥 已完成的 session 列表
   */
  sessionList?: Array<{
    sessionId: string;
    status: string;
    sessionGoal?: string;
    executionFlow?: {
      actual: string; // 🔥 实际执行轨迹
    };
  }>;
  /**
   * 🔥 调用历史
   */
  callHistory?: Array<{
    depth: number;
    actions: string[];
    result: string;
  }>;
  /**
   * 🔥 指定 session 的详细上下文
   */
  sessionContext?: Array<{
    apiRole?: string;
    content?: string;
    result?: string;
    statusCode?: number;
  }>;
  /**
   * 🔥 Agent 消息（用于 Agent 与 SummaryHandler 通信）
   */
  agentMessage?: string;
  /**
   * 🔥 对话上下文
   */
  context?: {
    conversationId?: string;
    userId?: string;
  };
}

/**
 * 🔥 Summary 工具调用（替代旧的 sessionActions 字符串数组）
 * LLM 通过 tools 数组返回 session 操作，格式与 ReAct 的 tools 一致
 */
export interface SummaryTool {
  name: string;  // 'sessioncreate' | 'getContext' | 'killsession'
  parameters: {
    task?: string;       // sessioncreate: 任务描述
    priority?: boolean;  // sessioncreate: 是否优先
    sessionId?: string;  // getContext/killsession: session ID
  };
}

/**
 * 🔥 统一总结响应
 */
export interface SummaryResponse {
  success: boolean;
  tools?: SummaryTool[];  // 🔥 工具调用列表（替代 sessionActions）
  say_to_user?: string;
  say_to_agent?: string;  // 🔥 对 Agent 说的话
  writeNotes?: string;
  error?: string;
}

// 兼容性导出
export type ReceptionSummaryRequest = SummaryRequest;
export type ReceptionSummaryResponse = SummaryResponse;
export type InvestigationSummaryRequest = SummaryRequest;
export type InvestigationSummaryResponse = SummaryResponse;
export type GatherSummaryRequest = SummaryRequest;
export type GatherSummaryResponse = SummaryResponse;
export type ReactionLoopSummaryRequest = SummaryRequest;
export type ReactionLoopSummaryResponse = SummaryResponse;

export class SummaryModule {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * 🔥 统一总结 - 处理所有用户需求
   * 
   * 合并了原来的 receptionSummary 和 investigationSummary
   * - depth=0: 初始需求分析（接待）
   * - depth>=1: 调查后分析（基于工具结果）
   */
  async summary(
    request: SummaryRequest,
    userLLMConfig?: Record<string, string>
  ): Promise<SummaryResponse> {
    try {
      const currentDepth = request.currentDepth ?? 0;
      const maxDepth = request.maxDepth ?? 6;
      const remainingDepth = Math.max(0, maxDepth - currentDepth - 1);
      const isInitial = currentDepth === 0;

      console.log(`📝 [SummaryModule] 统一总结 (depth: ${currentDepth}/${maxDepth}):`, {
        envTextLength: request.environmentText.length,
        callHistoryCount: request.callHistory?.length || 0,
        isInitial,
      });

      // 🔥 文件信息和对话历史现在通过 environmentText 传递，无需单独构建

      // 🔥 获取协议（systemPrompt 已不含轮次占位符，完全固定，优化缓存命中率）
      const summaryProtocol = SummaryProtocols.get('summary');
      const systemPrompt = summaryProtocol.systemPrompt
        .replace('{currentDepth}', '')  // 🔥 清除占位符，轮次信息移到 userPrompt
        .replace('{maxDepth}', '')
        .replace('{remainingDepth}', '')
        .replace('{toolResultsSection}', '')
        // 🔥 清理空的轮次行
        .replace(/## 交互轮次\n- 当前轮次：第  轮 \|共  轮 \|剩  轮\n?/, '')
        .trim();

      const maxTokens = summaryProtocol.maxTokens;

      // 🔥 构建额外的上下文信息
      let additionalContext = '';

      // 🔥 解析 writeNotes，按 depth 分组
      // 格式：【Depth N】\n笔记内容\n---\n【Depth M】\n笔记内容
      const notesByDepth: Map<number, string> = new Map();
      if (request.writeNotes) {
        const depthNoteRegex = /【Depth\s+(\d+)】\n([\s\S]*?)(?=---|\n【Depth|$)/g;
        let match;
        while ((match = depthNoteRegex.exec(request.writeNotes)) !== null) {
          const depth = parseInt(match[1], 10);
          const noteContent = match[2].trim();
          if (noteContent) {
            notesByDepth.set(depth, noteContent);
          }
        }
      }

      // 🔥 笔记单独展示，放在已交互历史前面，确保 LLM 重视笔记内容
      if (notesByDepth.size > 0) {
        additionalContext += `\n\n## ⚠️ 你记录过的笔记（务必参考，避免重复操作）\n`;
        const sortedDepths = [...notesByDepth.keys()].sort((a, b) => a - b);
        for (const depth of sortedDepths) {
          additionalContext += `[Depth ${depth}] ${notesByDepth.get(depth)}\n`;
        }
      }

      // 🔥 已交互历史（操作·结果两层展示）
      // 🔥 放在 sessionList 前面，因为 LLM 更关注当前交互历史
      if (request.callHistory && request.callHistory.length > 0) {
        const totalCalls = request.callHistory.length;
        const CLEAR_WINDOW = 2; // 🔥 最近2轮显示完整内容
        const startIndex = Math.max(0, totalCalls - CLEAR_WINDOW);

        additionalContext += `\n\n## 执行历史（共 ${totalCalls} 轮，最近 ${CLEAR_WINDOW} 轮会完整显示）\n`;

        request.callHistory.forEach((call, index) => {
          const isInClearWindow = index >= startIndex;
          additionalContext += `[Depth ${call.depth}] 操作: ${call.actions.join(', ')}\n`;

          if (isInClearWindow) {
            // 🔥 在 clearWindow 内，显示完整结果
            additionalContext += `结果汇报如下: ${call.result}\n`;
          } else {
            // 🔥 不在 clearWindow 内，只显示摘要（前100字符）
            const summary = call.result.substring(0, 100);
            additionalContext += `结果汇报如下: ${summary}${call.result.length > 100 ? '... [已截断]' : ''}\n`;
          }
          additionalContext += '\n';
        });
      }

      // 🔥 添加 sessionList 到上下文（只包含基本信息，completeReport 在 callHistory 中）
      if (request.sessionList && request.sessionList.length > 0) {
        additionalContext += `\n\n## Session 轨迹\n`;
        request.sessionList.forEach((session, index) => {
          additionalContext += `[${index + 1}] ${session.sessionId} - ${session.status}`;
          if (session.sessionGoal) {
            additionalContext += ` - 目标: ${session.sessionGoal}`;
          }
          // 🔥 只添加执行轨迹（简短信息）
          if (session.executionFlow?.actual) {
            const tracePreview = session.executionFlow.actual.substring(0, 100);
            additionalContext += `\n    执行轨迹: ${tracePreview}${session.executionFlow.actual.length > 100 ? '...' : ''}`;
          }
          additionalContext += '\n';
        });
      }

      // 🔥 添加 sessionContext 到上下文（getContext 获取的 session 详细上下文）
      if (request.sessionContext && request.sessionContext.length > 0) {
        additionalContext += `\n\n## Session 详细上下文（来自 getContext）\n`;
        request.sessionContext.forEach((ctx, index) => {
          additionalContext += `[${index + 1}] 角色: ${ctx.apiRole || 'unknown'}\n`;
          if (ctx.content) {
            additionalContext += `内容: ${ctx.content}\n`;
          }
          if (ctx.result) {
            additionalContext += `结果: ${ctx.result}\n`;
          }
          additionalContext += '\n';
        });
      }

      // 🔥 添加 Agent 消息（如果有）
      if (request.agentMessage) {
        additionalContext += `\n\n## 本轮收到来自Agent 消息\n${request.agentMessage}\n`;
      }

      // 🔥 轮次信息放在 userPrompt 末尾（动态内容放最后，优化缓存命中率）
      additionalContext += `\n\n## 交互轮次\n- 已经调用过 ${currentDepth} 轮 |共 ${maxDepth} 轮 |剩 ${remainingDepth} 轮`;
      // 🔥 提醒 LLM 这不是第一次交互，避免它重新做自我介绍或重复已完成的工作
      if (currentDepth >= 1) {
        additionalContext += `\n- ⚠️ 这是后续轮次，你已与用户交互过，重点查阅执行历史和session轨迹，切勿重复执行`;
      }
      // 🔥 在 userPrompt 末尾强调 JSON 格式要求，防止长上下文末尾 LLM 丧失对 systemPrompt 格式的注意力
      additionalContext += `\n\n⚠️ 返回需严格按照 system prompt 要求的 JSON 格式和语法，不要返回自然语言，不可使用session内部工具。`;

      // 🔥 使用前端构建的环境文本作为用户提示
      // environmentText 已包含 userQuery、files、conversationHistory、memories 等所有环境信息
      let userPrompt = `${request.environmentText}${additionalContext}`;

      // 🔥 构建多模态消息：提取用户上传的图片 URL，转为 image_url content part
      // 只在第一轮 + 模型支持多模态（用户声明 || 前缀表） + userQuery中有用户主动上传的图片 时才传
      const multimodalContent = await buildMultimodalContent(userPrompt, currentDepth, this.config.model, this.config.supportsVision, this.config.url);
      const userMessage: LLMMessage = { role: "user", content: multimodalContent };

      // 🔥 最后一公里：媒体已直接附带在用户消息里（模型能直接看到），必须在 system 提示词里
      // 明确告知"直接回答"，否则任务规划者人设会让模型照样 sessioncreate 派活去"分析"视频
      // （实测：视频 token 已进上下文，但模型仍按规划者惯性派活，2026-08 方舟对照实验证实）
      const hasMediaAttached = Array.isArray(multimodalContent) && multimodalContent.some(p => p.type === 'image_url' || p.type === 'video_url');
      // 🔥 当前时间注入（精确到分，东八区）：放 systemPrompt 尾部——固定前缀照常缓存命中，动态只占末尾几个 token；
      // 让模型有时效感（写搜索词用真实日期、判断内容新旧），不再凭训练记忆猜年份
      const nowCn = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
      const timeSuffix = `\n\n[当前时间] ${nowCn}（东八区）`;
      const finalSystemPrompt = (hasMediaAttached
        ? `${systemPrompt}\n\n【重要】用户上传的图片/视频内容已直接附带在用户消息中，你可以直接看到它们的全部内容。当用户询问这些媒体的内容时，必须直接在 say_to_user 中给出完整回答，禁止创建 session 或调用任何工具去分析这些已附带的媒体。`
        : systemPrompt) + timeSuffix;

      // 🔥 调试日志已移除（Reactor 侧已有详细日志）

      // 🔥 调试：检查是否有重复内容（仅开发环境）
      if (process.env.NODE_ENV === 'development') {
        const envText = request.environmentText || '';
        // 检查 systemPrompt 中的内容是否在 envText 中重复
        const toolSysIntro = '## 工具系统介绍';
        const roundInfo = '## 当前轮次信息';
        if (envText.includes(toolSysIntro)) {
          console.warn('⚠️ [SummaryModule] environmentText 包含工具系统介绍，可能与 systemPrompt 重复');
        }
        if (envText.includes(roundInfo)) {
          console.warn('⚠️ [SummaryModule] environmentText 包含轮次信息，可能与 systemPrompt 重复');
        }
      }

      const llmResponse = await llmService.callWithConfig({
        messages: [
          { role: "system", content: finalSystemPrompt },
          userMessage
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      }, this.config, 600000);  // 🔥 10分钟超时，前沿模型如 K2.6 响应较慢

      if (!llmResponse.success) {
        console.error("❌ [SummaryModule] LLM调用失败:", llmResponse.error);
        throw new Error(`LLM调用失败: ${llmResponse.error}`);
      }

      if (llmResponse.usage) {
        tokenUsageService.recordUsage(
          'summary',
          this.config.model,
          llmResponse.usage,
          request.context?.conversationId,
          request.currentDepth,
          llmResponse.duration
        );
      }

      const content = llmResponse.content || "";
      console.log("🤖 [SummaryModule] AI响应:", content);

      if (!content || content.trim() === '') {
        console.error("❌ [SummaryModule] LLM返回空内容");
        return { success: false, error: 'LLM 返回空内容' };
      }

      // 🔥 解析响应
      // 修复：处理包含 LaTeX 公式（反斜杠）的 JSON
      let parsed;
      let jsonParseSuccess = false;
      try {
        // 方案1：直接尝试解析整个 content（如果它已经是有效的 JSON）
        parsed = safeJSONParse(content);
        if (parsed && typeof parsed === 'object') {
          jsonParseSuccess = true;
          console.log("✅ [SummaryModule] JSON解析成功:", parsed);
        }
      } catch (e) {
        console.warn("⚠️ [SummaryModule] JSON解析失败");
      }

      // 🔥 如果 JSON 解析成功，直接使用解析后的对象（不再进入 fallback）
      if (jsonParseSuccess && parsed) {
        console.log("✅ [SummaryModule] JSON解析成功，直接使用解析后的对象");
      } else {
        // 🔥 JSON 解析失败，进入 fallback 逻辑（尝试提取各字段）
        console.warn("⚠️ [SummaryModule] JSON解析失败，尝试提取关键字段");

        // 🔥 方案2：使用正则逐个提取字段
        let extractedSayToUser = '';
        let extractedTools: SummaryTool[] | undefined;
        let extractedWriteNotes: string | undefined;

        // 提取 say_to_user（escape-aware 正则：跳过 \" 等转义，避免在转义引号处截断）
        const sayToUserMatch = content.match(/"say_to_user"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:[,}])/);
        if (sayToUserMatch && sayToUserMatch[1]) {
          // 🔥 用统一反转义（含 LaTeX 命令保护），手动 replace 链会把 \nu → 换行+u、\theta → TAB+heta
          extractedSayToUser = unescapeJSONString(sayToUserMatch[1]);
        }

        // 🔥 提取 tools：定位 "tools" 后的数组起点，字符串感知平衡扫描取整个数组
        // （旧 lazy 正则遇 task 值含 "],` 会把数组切半；旧逐对象正则 [^}]* 遇嵌套
        //   parameters 也截断。平衡扫描 + safeJSONParse 全修复管线双保险）
        const toolsKeyIdx = content.indexOf('"tools"');
        if (toolsKeyIdx >= 0) {
          const arrStart = content.indexOf('[', toolsKeyIdx);
          const arrEnd = arrStart >= 0 ? findBalancedEnd(content, arrStart) : -1;
          const sliceStart = arrStart >= 0 ? arrStart : toolsKeyIdx;
          const sliceEnd = arrEnd >= 0 ? arrEnd + 1 : content.length;
          const parsedTools = safeJSONParse(content.slice(sliceStart, sliceEnd));
          if (Array.isArray(parsedTools)) {
            // 🔥 key 漂移归一（params/arguments→parameters、tool→name），防静默空任务
            extractedTools = parsedTools
              .map(normalizeToolAliases)
              .filter((t): t is SummaryTool => t !== null);
          }
          // 数组整体解析失败：平衡提取各对象逐个抢救（宁可缺失不可错误）
          if (!extractedTools?.length) {
            const objs = extractJSONObjects(content.slice(sliceStart, sliceEnd));
            extractedTools = objs
              .map(normalizeToolAliases)
              .filter((t): t is SummaryTool => t !== null);
          }
        }

        // 🔥 提取 writeNotes（escape-aware 正则 + 统一反转义）
        const writeNotesMatch = content.match(/"writeNotes"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:[,}])/);
        if (writeNotesMatch && writeNotesMatch[1]) {
          extractedWriteNotes = unescapeJSONString(writeNotesMatch[1]);
        }

        parsed = {
          say_to_user: extractedSayToUser,
          tools: extractedTools,
          writeNotes: extractedWriteNotes,
        };

        if (extractedTools?.length) {
          console.log("✅ [SummaryModule] fallback 成功提取 tools:", extractedTools);
        }
        if (extractedSayToUser) {
          console.log("✅ [SummaryModule] fallback 成功提取 say_to_user，长度:", extractedSayToUser.length);
        }

        // 🔥 如果所有提取都失败，使用原始内容作为 say_to_user
        if (!extractedSayToUser && !extractedTools?.length) {
          console.warn("⚠️ [SummaryModule] 提取所有字段失败，使用原始内容作为 say_to_user");
          let cleanContent = content.trim();
          if (cleanContent.startsWith('{') && !jsonParseSuccess) {
            cleanContent = cleanContent.replace(/^\{\s*"say_to_user"\s*:\s*"/, '');
            cleanContent = cleanContent.replace(/"\s*(?:,\s*[\s\S]*)?\s*\}\s*$/, '');
            // 🔥 统一反转义（含 LaTeX 命令保护）
            cleanContent = unescapeJSONString(cleanContent);
          }
          parsed = { say_to_user: cleanContent || content };
        }
      }

      // 🔥 兼容旧格式：如果 LLM 仍返回 sessionActions 字符串数组，转换为 tools
      let tools: SummaryTool[] | undefined;
      const rawTools = parsed?.tools;
      if (Array.isArray(rawTools)) {
        // 🔥 主路径（JSON 解析成功）同样过 key 漂移归一：{name, params:{task}}
        // 不归一会变成 parameters:{} → sessioncreate 空任务启动会话（比丢失更糟）
        tools = rawTools
          .map(normalizeToolAliases)
          .filter((t): t is SummaryTool => t !== null);
      }
      if (!tools && parsed.sessionActions) {
        const rawActions = Array.isArray(parsed.sessionActions) ? parsed.sessionActions
          : typeof parsed.sessionActions === 'string' ? [parsed.sessionActions]
          : [];
        tools = (rawActions as string[]).map((s: string) => {
          const trimmed = s.trim();
          if (trimmed.startsWith('session++')) {
            const task = trimmed.replace(/^session\+\+/, '').trim();
            const isPriority = task.startsWith('[priority]');
            return { name: 'sessioncreate', parameters: { task: isPriority ? task.replace(/^\[priority\]\s*/, '') : task, priority: isPriority } };
          }
          if (trimmed.startsWith('getContext++')) {
            return { name: 'getContext', parameters: { sessionId: trimmed.replace(/^getContext\+\+/, '').trim() } };
          }
          if (trimmed.startsWith('killSession++')) {
            return { name: 'killsession', parameters: { sessionId: trimmed.replace(/^killSession\+\+/, '').trim() } };
          }
          return null;
        }).filter(Boolean) as SummaryTool[];
        if (tools.length) {
          console.log('🔄 [SummaryModule] 旧格式 sessionActions 已转换为 tools:', tools);
        }
      }

      // 🔥 意图闸门：原文含 session 动作名但 tools 没解析出来 = 回传/解析层问题
      // （key 漂移、括号边界碎裂等）→ 最后抢救；原文连动作名都没有 = LLM 本来
      // 就没派活，tools=undefined 合法，不浪费修复（该丢就丢，底线不破坏）
      if (!tools?.length && SESSION_ACTION_RE.test(content)) {
        const salvaged = salvageToolsFromText(content, SESSION_ACTION_NAMES);
        // 宁缺毋滥：sessioncreate 无 task = 意图不完整，空任务会话比丢任务更糟
        const usable = salvaged?.filter(t => t.name !== 'sessioncreate' || t.parameters.task);
        if (usable?.length) {
          console.warn('🔧 [SummaryModule] 意图推断抢救成功（JSON 碎裂但 action 意图明确）:', usable.map(t => t.name).join(', '));
          tools = usable as SummaryTool[];
        } else {
          console.error('❌ [SummaryModule] 检测到 session 意图但抢救失败，sessioncreate 可能丢失:', content.substring(0, 300));
        }
      }

      return {
        success: true,
        tools: tools,
        say_to_user: parsed.say_to_user,
        say_to_agent: parsed.say_to_agent,
        writeNotes: parsed.writeNotes,
      };
    } catch (error) {
      console.error("❌ [SummaryModule] 总结异常:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }

  // 🔥 兼容性方法（都指向统一的 summary 方法）
  async receptionSummary(request: SummaryRequest, userLLMConfig?: Record<string, string>): Promise<SummaryResponse> {
    return this.summary(request, userLLMConfig);
  }

  async investigationSummary(request: SummaryRequest, userLLMConfig?: Record<string, string>): Promise<SummaryResponse> {
    return this.summary(request, userLLMConfig);
  }

  async generateSummary(request: SummaryRequest, userLLMConfig?: Record<string, string>): Promise<SummaryResponse> {
    return this.summary(request, userLLMConfig);
  }

  async gatherSummary(request: SummaryRequest, userLLMConfig?: Record<string, string>): Promise<SummaryResponse> {
    return this.summary(request, userLLMConfig);
  }

  async reactionLoopSummary(request: SummaryRequest, userLLMConfig?: Record<string, string>): Promise<SummaryResponse> {
    return this.summary(request, userLLMConfig);
  }
}
