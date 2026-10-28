/**
 * 环境构建器
 *
 * 职责：
 * 1. 根据 Loop 信息选择注入策略
 * 2. 从各处获取环境数据（AvailableToolsRegistry 等）
 * 3. 根据策略构建环境文本
 * 4. 返回构建结果
 */

import {
  LoopInfo,
  EnvironmentData,
  EnvironmentContext,
  EnvironmentResult,
  ConversationEntry,
  InjectionStrategy,
} from './types';
import { StrategySelectorClass, defaultStrategySelector } from './strategies';
import { getGatherToolsSummary, getExecutionToolNames, getExecutionToolsWithParams } from '../AvailableToolsRegistry';
import { UserInjectMessageManager } from './UserInjectMessageManager';
import { knowledgeBaseService } from '../knowledge/KnowledgeBaseService';
import { importantObjectTracker } from '../context/ImportantObjectTracker';
import { getBackendUrl } from '@/config/env';
import { sshListActive } from '@/utils/systemtools/sshInstance';

/**
 * 环境构建器配置
 */
export interface EnvironmentBuilderConfig {
  /** 策略选择器 */
  strategySelector?: StrategySelectorClass;
  /** 是否启用动态调整 */
  enableDynamicAdjustment?: boolean;
}

/**
 * 环境构建器
 */
export class EnvironmentBuilder {
  private strategySelector: StrategySelectorClass;
  private enableDynamicAdjustment: boolean;

  constructor(config: EnvironmentBuilderConfig = {}) {
    this.strategySelector = config.strategySelector || defaultStrategySelector;
    this.enableDynamicAdjustment = config.enableDynamicAdjustment !== false;
  }

  /**
   * 构建环境文本
   *
   * @param loopInfo Loop 信息（角色、轮次等，用于决策策略）
   * @param data 环境数据（实际要注入的内容）
   * @param options 可选参数
   * @returns 环境构建结果
   */
  async build(
    loopInfo: LoopInfo,
    data: EnvironmentData,
    options: {
      /** 对话历史（用于注入上下文） */
      conversationHistory?: Array<{ role: string; content: string; sessionId?: string; apiRole?: string }>;
      /** 会话ID */
      conversationId?: string;
      /** 🔥 用户ID（用于短 ID 置换：@projectid:短id → 完整 UUID，否则"本地目录"拼出假路径） */
      userId?: string;
    } = {}
  ): Promise<EnvironmentResult> {
    // 1. 选择策略
    let strategy = this.strategySelector.selectStrategy(loopInfo);

    // 2. 动态调整策略（基于规则）
    if (this.enableDynamicAdjustment) {
      strategy = this.strategySelector.adjustStrategy(strategy, loopInfo);
    }

    // 3. 获取环境上下文（对话历史等）
    const context = await this.gatherContext(loopInfo, options);

    // 🔥 更新重要对象缓存（从对话历史中提取 appId, fileId 等）
    if (options.conversationId && context.conversationHistory.length > 0) {
      importantObjectTracker.updateConversationObjects(
        options.conversationId,
        context.conversationHistory.map(h => ({
          content: h.content,
          timestamp: h.timestamp,
        }))
      );
      // 🔥 短 ID 置换：登记的是 @projectid:8位短id，不置换则 getAppBasePath 拼出假目录注入给 LLM
      if (options.userId) {
        await importantObjectTracker.resolveShortAppIds(options.conversationId, options.userId);
      }
    }

    // 5. 根据策略构建文本（拆分 static/dynamic）
    const { staticText, dynamicText } = await this.buildText(data, context, strategy, loopInfo, { conversationId: options.conversationId });

    // 6. 记录注入的字段
    const injectedFields = this.getInjectedFields(strategy, context, data);

    return {
      text: [staticText, dynamicText].filter(s => s.length > 0).join('\n\n'),
      staticText,
      dynamicText,
      injectedFields,
      strategy: strategy.name,
    };
  }

  /**
   * 收集环境上下文
   */
  private async gatherContext(
    loopInfo: LoopInfo,
    options: {
      conversationHistory?: Array<{ role: string; content: string; sessionId?: string; apiRole?: string }>;
      conversationId?: string;
    }
  ): Promise<EnvironmentContext> {
    const context: EnvironmentContext = {
      conversationHistory: [],
      agentCapabilities: [],
    };

    // 1. 获取对话历史（直接使用传入的 conversationHistory）
    if (options.conversationHistory && options.conversationHistory.length > 0) {
      context.conversationHistory = options.conversationHistory.map((h) => ({
        role: h.role as 'user' | 'assistant' | 'system' | 'auto',
        content: h.content,
        timestamp: (h as any).timestamp || Date.now(), // 🔥 优先使用消息自身的时间戳
        sessionId: h.sessionId,
        apiRole: h.apiRole as 'summarizer' | 'reactor' | undefined,
      }));
    }

    // 2. 获取 Agent 能力
    context.agentCapabilities = getExecutionToolNames();

    // 3. 获取 UserPC 环境信息
    context.userPC = this.getUserPCEnvironment();

    // 4. 获取用户注入消息（用户在处理过程中发送的补充消息）
    if (options.conversationId) {
      context.userInjectMessages = UserInjectMessageManager.consumeMessages(options.conversationId);
    }

    return context;
  }

  /**
   * 获取 UserPC 环境信息
   */
  private getUserPCEnvironment(): Record<string, any> {
    try {
      // 获取浏览器/运行时环境信息
      const env = {
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        language: typeof navigator !== 'undefined' ? navigator.language : 'unknown',
        screenResolution: typeof screen !== 'undefined' 
          ? `${screen.width}x${screen.height}` 
          : 'unknown',
        timezone: typeof Intl !== 'undefined' 
          ? Intl.DateTimeFormat().resolvedOptions().timeZone 
          : 'unknown',
        // 🔥 移除 timestamp，避免每轮环境文本变化导致缓存命中率下降
      };
      return env;
    } catch (error) {
      return { error: '无法获取环境信息' };
    }
  }

  /**
   * 构建环境文本（拆分为 static/dynamic 两部分，优化缓存命中率）
   *
   * static 部分（ExecutionTools、UserPC）：每轮不变，放在 executionHistory 前面，可缓存命中
   * dynamic 部分（ImportantObjects、UserInjectMessages、KnowledgeBase 等）：可能每轮变化，放在 executionHistory 后面
   */
  private async buildText(
    data: EnvironmentData,
    context: EnvironmentContext,
    strategy: any,
    loopInfo: LoopInfo,
    options: {
      conversationId?: string;
    } = {}
  ): Promise<{ staticText: string; dynamicText: string }> {
    const staticSections: string[] = [];
    const dynamicSections: string[] = [];

    // 1. 用户需求（动态 - 每次查询不同）
    if (strategy.includeUserQuery && data.userQuery) {
      dynamicSections.push(this.buildUserQuerySection(data.userQuery));
    }

    // 2. 对话历史（动态 - 窗口可能变化）
    if (strategy.includeHistory && context.conversationHistory.length > 0) {
      const depth = loopInfo.currentRound;
      dynamicSections.push(this.buildHistorySection(context.conversationHistory, depth, data.userQuery));
    }

    // 3. Gather 阶段可用工具（固定 - 工具列表不变）
    if (strategy.includeGatherTools) {
      const gatherTools = getGatherToolsSummary();
      if (gatherTools.length > 0) {
        staticSections.push(this.buildGatherToolsSection(gatherTools));
      }
    }

    // 4. Execution 阶段可用工具（固定 - 工具列表不变）
    if (strategy.includeExecutionTools) {
      const executionTools = getExecutionToolsWithParams();
      if (executionTools.length > 0) {
        staticSections.push(this.buildExecutionToolsSection(executionTools));
      }
    }

    // 5. UserPC 环境（固定 - 平台信息不变）
    if (strategy.includeUserPC && context.userPC) {
      staticSections.push(await this.buildUserPCSection(context.userPC));
    }

    // 6. 用户注入消息（动态 - 用户随时可能注入）
    if (strategy.includeUserInjectMessages && context.userInjectMessages && context.userInjectMessages.length > 0) {
      dynamicSections.push(this.buildUserInjectMessagesSection(context.userInjectMessages));
    }

    // 7. 重要对象引用（动态 - 对象可能增长；执行轮附带活跃实例快照，项目条目直接带归属实例，免调 ssh_instance 查询省一轮）
    if (strategy.includeImportantObjects && options.conversationId) {
      let activeInstances: any[] = [];
      if (strategy.includeExecutionTools) {
        try {
          // 🔥 sync:true 与云端自愈校正（sshListActive 内部 60s TTL 缓存，每轮构建不会真打云端）——
          // 之前 sync:false 只读本地表，实例关机后状态过期，注入"运行中"快照误导 LLM
          const r = await sshListActive(undefined, { sync: true });
          if (r.ok) activeInstances = r.instances;
        } catch { /* 查询失败不影响重要对象段 */ }
      }
      // 🔥 内容根提示（穿透子目录名）：LLM 直接写对 read/push 相对路径前缀，免跑一轮文件树确认
      // （git clone 套层项目的内容根是 apps/{id}/xxx/，相对路径须带 xxx/ 前缀）
      const convObjects = importantObjectTracker.getConversationObjects(options.conversationId);
      let rootHints: Map<string, string> | undefined;
      const hintTargets = convObjects
        .filter((o: any) => o.type === 'app')
        .slice(0, 3);
      if (hintTargets.length > 0) {
        const entries = await Promise.all(hintTargets.map(async (p: any) => {
          const { getProjectRootHint } = await import('@/utils/apptool/AppPathHelper');
          const hint = await getProjectRootHint(p.id);
          return hint ? [p.id, hint] as [string, string] : null;
        }));
        const valid = entries.filter(Boolean) as [string, string][];
        if (valid.length > 0) rootHints = new Map(valid);
      }
      const importantObjectsText = await importantObjectTracker.getFormattedObjects(options.conversationId, activeInstances, rootHints);
      if (importantObjectsText) {
        // 🔥 逐轮可观测：注入了哪些对象、体积多少（排查"执行轮不知道本地目录"类问题）
        console.log(`[ENV-BUILDER] 重要对象注入 role=${loopInfo.role} round=${loopInfo.currentRound}: ` +
          `${convObjects.map((o: any) => `${o.type}:${String(o.id || o.name || '').slice(0, 12)}`).join(', ') || '(空)'} ` +
          `| ${importantObjectsText.length} 字符`);
        dynamicSections.push(importantObjectsText);
      }
    }

    // 8. 知识库检索（半固定 - 同一查询结果相同，但可能因查询变化而不同）
    // 🔥 使用 KnowledgeBaseService 的默认参数（集中配置）
    if (strategy.includeKnowledgeBase && data.userQuery) {
      const knowledgeText = knowledgeBaseService.searchAsText(data.userQuery);
      if (knowledgeText) {
        dynamicSections.push(this.buildKnowledgeBaseSection(knowledgeText));
      }
    }

    return {
      staticText: staticSections.filter(s => s.length > 0).join('\n\n'),
      dynamicText: dynamicSections.filter(s => s.length > 0).join('\n\n'),
    };
  }

  /**
   * 构建知识库段落
   */
  private buildKnowledgeBaseSection(knowledgeText: string): string {
    return `## 相关知识库
以下是与用户需求相关的平台知识，供参考：

${knowledgeText}`;
  }

  /**
   * 构建用户注入消息段落
   */
  private buildUserInjectMessagesSection(messages: NonNullable<EnvironmentContext['userInjectMessages']>): string {
    const lines = messages.map((msg, index) => {
      const fileInfo = msg.files && msg.files.length > 0
        ? ` [附${msg.files.length}个文件]`
        : '';
      return `${index + 1}. ${msg.content}${fileInfo}`;
    });
    return `## 用户补充消息\n${lines.join('\n')}\n\n`;
  }

  /**
   * 构建用户需求段落
   */
  private buildUserQuerySection(userQuery: string): string {
    return `## 当前用户qurey\n${userQuery}`;
  }



  /**
   * 构建对话历史段落
   * @param history 完整对话历史（已在前端按 session 折叠）
   */
  private buildHistorySection(history: ConversationEntry[], _depth: number = 0, userQuery?: string): string {
    // 🔥 根据 userQuery 定位当前对话：找到内容匹配的最后一条用户消息
    let currentUserQueryIndex = -1;
    if (userQuery) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          const entryContent = history[i].content || '';
          // 匹配条件：userQuery 包含在历史消息中，或历史消息包含 userQuery
          if (entryContent.includes(userQuery) || userQuery.includes(entryContent)) {
            currentUserQueryIndex = i;
            break;
          }
        }
      }
    }

    // 🔥 history 已在前端 useWorkspaceHandlers 中按 session 折叠，这里直接使用全部
    // 不再做窗口截断，避免窗口大小变化导致缓存命中率下降
    const windowedHistory = history;

    const lines = windowedHistory.map((entry, index) => {
      const roleText = entry.role === 'user' ? '用户' :
                       entry.role === 'assistant' ? '助手' :
                       entry.role === 'auto' ? 'Agent' : '系统';
      // 🔥 标记当前对话，帮助 LLM 定位应回复的问题
      const marker = index === currentUserQueryIndex ? ' 【📍用户初始信息】' : '';
      return `${roleText}${marker}: ${entry.content}`;
    });

    return `## 对话历史（时间升序，末尾即当前任务的执行过程）\n${lines.join('\n')}\n💡 📍标注的是当前任务的userquery，其后到末尾都是它的执行过程，检查该需求是否已实现`;
  }


  /**
   * 构建 Gather 工具列表段落（含关键参数名，节省 token）
   */
  private buildGatherToolsSection(tools: { name: string; params?: string; isExtension?: boolean }[]): string {
    // 🔥 工具名后带上关键参数名，如 `- read_project_file [projectId, filePath]`；扩展工具加 * 标识
    const toolList = tools.map((t) => {
      const name = t.isExtension ? `${t.name}*` : t.name;
      if (t.params) {
        return `- ${name} [${t.params}]`;
      }
      return `- ${name}`;
    }).join('\n');
    return `## agent的工具列表\n${toolList}\n💡 方括号内为关键参数名，*为扩展工具`;
  }

  /**
   * 构建 Execution 工具段落（含关键参数名）
   */
  private buildExecutionToolsSection(tools: { name: string; params?: string; isExtension?: boolean }[]): string {
    const toolList = tools.map((t) => {
      const name = t.isExtension ? `${t.name}*` : t.name;
      if (t.params) {
        return `- ${name} [${t.params}]`;
      }
      return `- ${name}`;
    }).join('\n');
    return `## session内部工具\n${toolList}\n💡 方括号内为关键参数名，*为扩展工具；操作projectId:base-ext 可自写工具并热重载进列表`;
  }

  /**
   * 构建 UserPC 环境段落
   */
  private async buildUserPCSection(userPC: Record<string, any>): Promise<string> {
    const envInfo = Object.entries(userPC)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
    
    // 🔥 获取用户数据目录路径
    let outputPath = '';
    try {
      const electron = (window as any).electron;
      if (electron?.getUserDataPath) {
        const userDataPath = await electron.getUserDataPath();
        // 🔥 分隔符按平台选：硬编码 \ 会让 macOS/Linux 拼出 /Users/...\files\output 混种路径，
        // LLM 按这个提示保存文件必然存错位置
        const sep = electron.platform === 'win32' ? '\\' : '/';
        outputPath = `${userDataPath}${sep}files${sep}output`;
      }
    } catch (e) {
      // 如果获取失败，使用默认提示
    }

    const isWin = (window as any).electron?.platform === 'win32';
    // 🔥 标签明确写"成品"职责：与 ImportantObjectTracker 的「本地目录:」（项目工作文件）分工，
    //    避免泛化的"文件保存路径"诱导 LLM 把工作文件也塞进 output
    const pathHint = outputPath
      ? `- 成品输出目录（交付用户的最终文件，如视频/图片/文档）: ${outputPath}${isWin ? '\\' : '/'}filename.png`
      : (isWin
        ? `- 注意: 保存文件请用Windows路径如 C:\\output\\file.png`
        : `- 注意: 保存文件请用绝对路径如 /tmp/output/file.png`);

    // 云端产物交付提醒：仅当检测到运行中的云端实例时注入（本地任务不出现，避免误导与 token 浪费）
    const cloudHint = await this.getCloudDeliverHint();

    // 🔥 宿主端口保护（每轮必见；知识库是被动的，关键词不命中就看不到）：
    //    真实案例：项目测试脚本把 3001 写进 killPort 清理名单，宿主后端被杀，
    //    渲染层全部请求 CONNECTION_REFUSED、项目管理面板空白
    let hostPortHint = '';
    try {
      const backendPort = new URL(getBackendUrl()).port;
      if (backendPort) {
        hostPortHint = `- Teegal宿主端口: ${backendPort}（禁止占用/清理）`;
      }
    } catch { /* URL 解析失败不注入 */ }

    const sections = [`## 用户环境`, envInfo, pathHint];
    if (cloudHint) sections.push(cloudHint);
    if (hostPortHint) sections.push(hostPortHint);
    return sections.join('\n');
  }

  /**
   * 云端产物交付提醒（两种链路，提示各自成立）：
   * - Linux 客户端只出现在云端镜像上（邮件指挥链路）：agent 就跑在云端机上，产物在本机磁盘，
   *   uploadfiletooss 直读本机文件上传即可——无需探测，平台即判定
   * - 其余平台检测到运行中的云端实例（客户端 SSH 指挥链路）：只提醒别把成果留在云端机，不指定回传方式
   */
  private async getCloudDeliverHint(): Promise<string> {
    if (/Linux/i.test(navigator.platform || '')) {
      return '- 云端电脑提醒: 你正运行在云端电脑上，产物文件就在本机磁盘。完成后用 uploadfiletooss 上传本机文件拿到 URL 交付用户，不要把成果只留在云端机上（机器销毁后数据即销毁）';
    }
    try {
      const resp = await fetch(`${getBackendUrl()}/api/rental/resources?userId=`, { signal: AbortSignal.timeout(2000) });
      const data: any = await resp.json().catch(() => null);
      const running = (data?.resources || []).some((r: any) => r?.status === 'running');
      if (!running) return '';
      return '- 云端电脑提醒: 检测到云端电脑运行中，若任务在其上执行，最终产物不要只留在云端机上，完成后回传交付给用户';
    } catch {
      return '';
    }
  }

  /**
   * 获取实际注入的字段列表
   */
  private getInjectedFields(strategy: any, context: EnvironmentContext, data: EnvironmentData): string[] {
    const fields: string[] = [];

    if (strategy.includeUserQuery && data.userQuery) fields.push('userQuery');
    if (strategy.includeHistory && context.conversationHistory.length > 0) fields.push('conversationHistory');
    if (strategy.includeGatherTools) fields.push('gatherTools');
    if (strategy.includeExecutionTools) fields.push('executionTools');
    if (strategy.includeUserPC && context.userPC) fields.push('userPC');

    return fields;
  }
}

/**
 * 默认环境构建器实例
 */
export const defaultEnvironmentBuilder = new EnvironmentBuilder({});

/**
 * 便捷函数：快速构建环境
 */
export async function buildEnvironment(
  loopInfo: LoopInfo,
  data: EnvironmentData,
  options?: {
    conversationHistory?: Array<{ role: string; content: string }>;
    conversationId?: string;
    userId?: string;
  }
): Promise<EnvironmentResult> {
  return defaultEnvironmentBuilder.build(loopInfo, data, options);
}
