/**
 * ReActService - ReAct (Reasoning + Acting) 推理服务
 *
 * 职责:
 * - 只负责 LLM 推理：生成 letMeDo 和 Tools
 * - 不执行工具，工具执行由前端完成
 * - 返回每轮的 letMeDo + Tools 给前端
 */

import { ReActProtocols } from './protocols';
import { llmService } from '../utils/LLMService';
import { unifiedModelRegistry } from '../utils/llm/UnifiedModelRegistry';
import { OrganizationSubCategory } from '../utils/llm/types';
import { safeJSONParse } from './utils/JSONParser';
import { tokenUsageService } from '../utils/TokenUsageService';
import { credentialDAO } from '../local-storage/dao/CredentialDAO';

/**
 * 🔥 从凭据表读取 param 型参数（明文存储，后端可直接读 encrypted_value）
 * 没有配置或读取失败时返回默认值
 */
function getParamValue(name: string, userId: string, defaultValue: number): number {
  try {
    const param = credentialDAO.getByName(name, userId);
    if (param && param.type === 'param') {
      const parsed = parseInt(param.encrypted_value, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch (error) {
    console.warn(`[REACT-SERVICE] 读取参数 ${name} 失败，使用默认值 ${defaultValue}:`, error);
  }
  return defaultValue;
}

export interface ReActRoundRequest {
  roundNumber: number;
  maxRounds: number;
  sessionId: string;
  userId: string;
  conversationId: string;
  letAgentTodo: string;
  toolResults?: Array<{
    toolName: string;
    parameters: Record<string, any>;
    /** 🔥 真实轮号（executor push 时写入）：后端折叠行按真实轮号渲染，保证内容稳定 */
    roundNumber?: number;
    /** 🔥 主动归档标记（LLM 传 archive=true 后由 executor 写入） */
    archived?: boolean;
    result: {
      success: boolean;
      data?: any;
      error?: string;
    };
  }>;
  environmentText?: string; // 🔥 环境文本（向后兼容）
  staticEnvironmentText?: string; // 🔥 固定部分环境文本（ExecutionTools、UserPC 等，每轮不变）
  dynamicEnvironmentText?: string; // 🔥 动态部分环境文本（ImportantObjects、UserInjectMessages 等）
  writeNotes?: string; // 🔥 工作笔记，防止遗忘
}

export interface ReActRoundResponse {
  success: boolean;
  roundNumber: number;
  letMeDo: string;
  writeNotes?: string; // 🔥 工作笔记
  completeReport?: string; // 🔥 任务完成总结报告
  tools: Array<{
    name: string;
    parameters: Record<string, any>;
  }>;
  /** 🔥 主动归档请求：LLM 判断笔记已记全，本轮工具执行完后归档旧轮次 */
  archiveRequest?: boolean;
  /** 🔥 归档时保留最近几条完整（= clearWindow） */
  keepRecent?: number;
  error?: string;
}

export class ReActService {
  private static instance: ReActService;

  static getInstance(): ReActService {
    if (!ReActService.instance) {
      ReActService.instance = new ReActService();
    }
    return ReActService.instance;
  }

  /**
   * 执行单轮 ReAct 推理
   * 返回 letMeDo + Tools，不执行工具
   */
  async executeRound(request: ReActRoundRequest): Promise<ReActRoundResponse> {
    const {
      roundNumber,
      maxRounds,
      sessionId,
      userId,
      letAgentTodo,
      toolResults,
      environmentText,
      staticEnvironmentText,
      dynamicEnvironmentText,
      writeNotes,
    } = request;

    // 从 environmentText 中提取 userQuery（第一行通常是用户查询）
    const userQuery = environmentText?.split('\n')[0]?.replace('用户查询:', '').trim() || '';

    try {
      // 🔥 clearWindow / maxHistoryChars 可从凭据表的 param 型参数读取，默认 5 / 36000
      // （实测 clearWindow=5 时归档批次对齐稳定，上游缓存命中 60%-80%）
      // 截断/折叠/动态压缩逻辑统一在 ReActProtocols.buildExecutionHistory 中处理
      const CLEAR_WINDOW = getParamValue('clearWindow', userId, 5);
      const MAX_HISTORY_CHARS = getParamValue('maxHistoryChars', userId, 36000);

      // 构建 Prompt
      const { systemPrompt, userPrompt, parts } = ReActProtocols.buildPrompt({
        roundNumber,
        maxRounds,
        userQuery,
        letAgentTodo,
        relevantFiles: [],
        toolResults: toolResults || [],
        environmentText,
        staticEnvironmentText,
        dynamicEnvironmentText,
        writeNotes,
        clearWindow: CLEAR_WINDOW, // 🔥 传入 clearWindow，保持与截断逻辑一致
        maxHistoryChars: MAX_HISTORY_CHARS, // 🔥 历史体积预算，超出自动梯度压缩
        sessionId, // 🔥 压缩级棘轮按 session 记忆（压缩一旦激活不回落，防历史内容反复变化打断缓存）
      });


      // 🔥 每轮 prompt 体积监控（一行带分项归因）+ 归档/笔记走势（总量/条数/最大单条，看笔记是否逐轮膨胀）
      const totalChars = systemPrompt.length + userPrompt.length;
      const promptKB = totalChars / 1024;
      const p = parts;
      const noteSegs = (writeNotes || '').split('\n---\n').filter(s => s.trim());
      const noteMax = noteSegs.length ? Math.max(...noteSegs.map(s => s.length)) : 0;
      const archivedCount = (toolResults || []).filter(t => t.archived).length;
      // 🔥 两个归档口径分开显示：自动归档=批次边界折叠（ReActProtocols 计算），
      // 主动归档=LLM 传 archive:true 的条目——此前混用"归档N条"造成"没在归档"的误判
      console.log(`[REACT-SERVICE] Round ${roundNumber} prompt: ${promptKB.toFixed(1)}KB (~${Math.round(totalChars / 3)} tokens) | 历史${(p.history / 1024).toFixed(1)}KB 自动归档${p.autoArchived ?? 0}条 主动归档${archivedCount}条 笔记${((writeNotes || '').length / 1024).toFixed(1)}KB/${noteSegs.length}条(max${noteMax}) 固定${(p.staticEnv / 1024).toFixed(1)}KB 动态${(p.dynamicEnv / 1024).toFixed(1)}KB`);

      // 调用 LLM
      let llmResponse = await this.callLLM(systemPrompt, userPrompt, userId, sessionId, roundNumber);

      if (!llmResponse.success) {
        return {
          success: false,
          roundNumber,
          letMeDo: '',
          tools: [],
          error: llmResponse.error,
        };
      }

      // 解析 letMeDo、writeNotes、completeReport 和 Tools
      const parsed = this.parseReActResponse(llmResponse.data || '');

      // 🔥 输出触顶救援：finish_reason=length 且 JSON 解析失败 = 内容型大输出（如整文件重写的
      //    save_project_file content）撞上 max_tokens 硬闸被拦腰截断，整轮白烧。去掉上限重试一次。
      //    硬闸默认保留（防镜像失控）；思维链失控场景（content 为空）由 LLMService 自带兜底先行处理
      let effective = { llmResponse, parsed };
      if (parsed.parseError && llmResponse.finishReason === 'length') {
        console.warn(`[REACT-SERVICE] Round ${roundNumber} 输出触顶截断（max_tokens=6000 且 JSON 解析失败），去掉上限重试一次`);
        const retry = await this.callLLM(systemPrompt, userPrompt, userId, sessionId, roundNumber, true);
        if (retry.success) {
          const retryParsed = this.parseReActResponse(retry.data || '');
          if (!retryParsed.parseError) {
            effective = { llmResponse: retry, parsed: retryParsed };
          } else {
            console.warn(`[REACT-SERVICE] Round ${roundNumber} 放宽重试后仍解析失败，沿用首轮结果`);
          }
        }
      }

      const { letMeDo, writeNotes: parsedWriteNotes, completeReport, tools, archive } = effective.parsed;

      // 🔥 如果有 completeReport，在末尾添加提示：report 内容对用户不可见
      const finalCompleteReport = completeReport
        ? `${completeReport}\n\n【注意：报告结果对用户不可见】`
        : completeReport;

      return {
        success: true,
        roundNumber,
        letMeDo,
        writeNotes: parsedWriteNotes,
        completeReport: finalCompleteReport,
        tools,
        // 🔥 主动归档：LLM 声明 archive=true 时连同 clearWindow 一起返回，
        // executor 据此给旧条目打 archived 标记（保留最近 clearWindow 条完整）
        archiveRequest: archive === true,
        keepRecent: CLEAR_WINDOW,
      };
    } catch (error) {
      console.error('[REACT-SERVICE] 推理失败:', { sessionId, roundNumber, error });

      return {
        success: false,
        roundNumber,
        letMeDo: '',
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 调用 LLM
   */
  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    userId?: string,
    sessionId?: string,
    roundNumber?: number,
    noOutputCap?: boolean
  ): Promise<{ success: boolean; data?: string; finishReason?: string; error?: string }> {
    try {
      // 获取用户的 LLM 配置
      const resolvedModel = unifiedModelRegistry.getModelForSubCategory(
        OrganizationSubCategory.EXECUTION,
        userId
      );

      if (!resolvedModel) {
        return { success: false, error: '未找到用户 LLM 配置' };
      }

      const response = await llmService.callWithConfig(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          // 🔥 reactor 是工具调用循环，不需要深度思考——低思考档省输出 token
          //（实测 deepseek 系不控时单轮 reasoning 可达 1.8 万字符）。summarizer 不传，保留默认思考强度
          reasoningEffort: 'low',
          // 🔥 输出硬闸（默认 6000）：reactor 正常输出（writeNotes+letMeDo+tools）< 2000 token，
          //   思考参数失效时防止模型把 prompt 长度镜像成长输出（实测 glm-5.3-flash 思考 26100 字符/轮 197s）。
          //   两类兜底：思维链耗尽预算（content 为空）→ LLMService 去限重试；
          //   内容型大输出触顶截断（JSON 解析失败）→ executeRound 去限重试一次（noOutputCap）
          ...(noOutputCap ? {} : { max_tokens: 6000 }),
        },
        resolvedModel.callConfig,
        600000  // 🔥 10分钟超时，前沿模型如 K2.6 响应较慢
      );

      if (!response.success) {
        return { success: false, error: response.error };
      }

      if (response.usage) {
        // 🔥 缓存命中率。字段来源：GLM=usage.prompt_tokens_details.cached_tokens（嵌套），
        // DeepSeek=prompt_cache_hit_tokens（顶层）——LLMService 归一化层已统一映射为后者。
        // 归档边界轮（每 clearWindow 轮一次）前 5 条折叠重构，0% 属设计内断点，
        // 判断缓存健康要看边界之间的轮次（纯追加轮应命中 50%+）
        const cacheHit = response.usage.prompt_cache_hit_tokens || 0;
        const promptTotal = response.usage.prompt_tokens || 0;
        const cacheRate = promptTotal > 0 ? ((cacheHit / promptTotal) * 100).toFixed(1) : '0.0';
        console.log(`[REACT-SERVICE] 缓存命中: ${cacheHit}/${promptTotal} tokens (${cacheRate}%) | Round ${roundNumber} | Session ${sessionId}`);

        tokenUsageService.recordUsage(
          'react',
          resolvedModel.callConfig.model,
          response.usage,
          sessionId,
          roundNumber,
          response.duration
        );
      }

      // 提取 content
      const content = response.content || '';
      return { success: true, data: content, finishReason: response.finishReason };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 解析 ReAct 响应 (JSON 格式)
   */
  private parseReActResponse(content: string): {
    letMeDo: string;
    writeNotes?: string;
    completeReport?: string;
    tools: Array<{ name: string; parameters: Record<string, any> }>;
    archive?: boolean;
    parseError?: string;
  } {
    // 🔥 DeepSeek 系模型偶发格式漂移：忽略 JSON 指令，输出训练时的原生 DSML 工具调用标记
    //（<｜DSML｜ invoke name="x"> ... <｜DSML｜ parameter name="p">v</｜DSML｜ parameter>）
    // 该格式 JSON 提取必然失败，之前会导致「无 tool 无 report」下一轮重试再漂移 → 空转烧轮次
    if (content.includes('DSML')) {
      const dsmlTools = this.parseDSMLToolCalls(content);
      if (dsmlTools.length > 0) {
        console.warn(`[REACT-SERVICE] 检测到 DSML 格式工具调用（DeepSeek 格式漂移），已转换 ${dsmlTools.length} 个工具`);
        return {
          letMeDo: '（模型以 DSML 格式返回工具调用，已自动转换执行）',
          writeNotes: undefined,
          completeReport: undefined,
          tools: dsmlTools,
        };
      }
    }

    // 提取 JSON
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ||
                      content.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.warn('[REACT-SERVICE] 未找到 JSON 响应');
      return {
        letMeDo: 'JSON 解析失败：未找到 JSON 响应，请重新输出正确的 JSON 格式',
        parseError: '未找到 JSON 响应',
        tools: [],
      };
    }

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = safeJSONParse(jsonStr);

    if (!parsed) {
      const errorPreview = jsonStr.substring(0, 200);
      console.error('[REACT-SERVICE] JSON 解析失败，原始内容:', errorPreview);
      // 🔥 第5层兜底：宽松字段提取。JSON 整体坏掉（多为 writeNotes 长文本含未转义引号）
      // 但关键字段的字符串值本身合法时仍可抢救——尤其 completeReport，抓到即任务完成；
      // 否则执行器只会「继续下一轮」，长任务会空转烧几百轮 token
      const salvage = this.salvageReActFields(jsonStr);
      if (salvage.completeReport || salvage.letMeDo) {
        console.warn('[REACT-SERVICE] JSON 整体解析失败，宽松提取抢救字段:', Object.keys(salvage).filter(k => (salvage as any)[k]).join(','));
        return {
          letMeDo: salvage.letMeDo || 'JSON 输出格式有误，已抢救关键信息',
          writeNotes: salvage.writeNotes,
          completeReport: salvage.completeReport,
          tools: [],
        };
      }
      return {
        letMeDo: `JSON 解析失败，请检查输出格式。上次输出开头: ${errorPreview}`,
        parseError: `JSON 解析失败: ${errorPreview}`,
        tools: [],
      };
    }

    const letMeDo = parsed.letMeDo || '继续执行任务';
    const writeNotes = parsed.writeNotes;
    const completeReport = parsed.completeReport;
    const tools = parsed.tools || [];
    // 🔥 主动归档请求：LLM 判断笔记已记全，本轮工具执行完后归档旧轮次（executor 侧打标记）
    const archive = parsed.archive === true;

    // 验证 tools 格式
    const validTools = tools.filter((t: any) =>
      t && typeof t === 'object' && t.name
    ).map((t: any) => ({
      name: t.name,
      parameters: t.parameters || {},
    }));

    return { letMeDo, writeNotes, completeReport, tools: validTools, archive };
  }

  /**
   * 🔥 解析 DeepSeek DSML 格式的工具调用（格式漂移兜底）
   * 实际标记形如 <｜DSML｜ invoke name="x"> / <｜DSML｜ parameter name="p" string="true">v</｜DSML｜ parameter>
   * 全角竖线数量在不同中转/版本下不稳定（｜ / ｜｜），故用宽松正则不依赖竖线：
   * 只要出现 `invoke name="..."` 与 `parameter name="..."` 结构即提取
   */
  private parseDSMLToolCalls(content: string): Array<{ name: string; parameters: Record<string, any> }> {
    const tools: Array<{ name: string; parameters: Record<string, any> }> = [];
    // 按下一个 invoke 或文本结束切分每个工具调用块
    const invokeRe = /invoke\s+name="([^"]+)"([\s\S]*?)(?=invoke\s+name=|$)/g;
    let m: RegExpExecArray | null;
    while ((m = invokeRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      if (!name) continue;
      const parameters: Record<string, any> = {};
      const paramRe = /parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\//g;
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(body)) !== null) {
        const key = p[1];
        let value: any = p[3];
        // string="true" 声明的参数保持字符串；否则尝试转数字/布尔
        const isString = /\sstring="true"/.test(p[2]);
        if (!isString) {
          const trimmed = value.trim();
          if (trimmed === 'true') value = true;
          else if (trimmed === 'false') value = false;
          else if (trimmed !== '' && !Number.isNaN(Number(trimmed))) value = Number(trimmed);
        }
        parameters[key] = value;
      }
      tools.push({ name, parameters });
    }
    return tools;
  }

  /**
   * 🔥 从损坏的 JSON 中宽松提取顶层字符串字段（值须是合法转义的字符串字面量）
   * 用于 safeJSONParse 全部修复层都失败的场景：整体非法但单个字段可抢救。
   * 抓到 completeReport 时执行器会按任务完成收尾，避免无限空转。
   */
  private salvageReActFields(jsonStr: string): { letMeDo?: string; writeNotes?: string; completeReport?: string } {
    const grab = (field: string): string | undefined => {
      const m = jsonStr.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (!m) return undefined;
      try {
        const v = JSON.parse(`"${m[1]}"`);
        return typeof v === 'string' && v.trim() ? v : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      letMeDo: grab('letMeDo'),
      writeNotes: grab('writeNotes'),
      completeReport: grab('completeReport'),
    };
  }
}

// 导出单例
export const reActService = ReActService.getInstance();
