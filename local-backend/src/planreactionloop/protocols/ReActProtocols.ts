/**
 * ReAct (Reasoning + Acting) 协议模块
 * 集中管理 ReAct 循环的系统提示词和 prompt 模板
 *
 * 优势：
 * 1. 便于调整和优化提示词效果
 * 2. 支持多套协议切换，增强结果鲁棒性
 * 3. 便于版本管理和 A/B 测试
 * 4. 降低 Service 类的复杂度
 */

export interface ReActProtocolConfig {
  /** 系统提示词 */
  systemPrompt: string;
  /** ReAct 循环提示词模板 */
  reactPromptTemplate: string;
}

/**
 * 标准 ReAct 协议
 *
 * 核心理念：
 * - letMeDo: 简要说明当前行动方案（简洁，用于展示）
 * - tools: 调用工具或完成任务
 * - Observation: 观察执行结果
 * - 循环直到任务完成
 */
const STANDARD_REACT_PROTOCOL: ReActProtocolConfig = {
  systemPrompt: `你的任务: {letAgentTodo}

请你使用 ReAct模式完成任务。

输出格式必须严格遵循JSON:
\`\`\`json
{
  "writeNotes": "本轮新增记忆：【本轮已确认】xxx | 【本轮待确认】xxx | 【关键线索】xxx（只记本轮新增，勿重复之前已记录内容）",
  "letMeDo": "简要说明action resoning，不透露工具名称",
  "tools": [
    {
      "name": "工具名称",
      "parameters": { "query": "指令内容" }
    }
  ],
  "archive": "（可选）true=本轮工具执行完后主动归档旧轮次：关键信息已记入笔记时使用，旧轮折叠为索引摘要防历史膨胀",
  "completeReport": "（可选）任务完成或最后一轮才需总结：关键成果（文件路径/数据/结论）"
}
\`\`\`

任务完成，提前跳出循环:
- 必须总结，且 tools 传空数组 []

省轮次规则:
- 无依赖的操作同轮并行（tools 一次传多个，单轮≤5个），有依赖才等下一轮
- 大体积结果（文件整读/搜索列表等）：关键结论立即记入笔记 → 传 "archive": true 归档旧轮腾预算，历史仅剩索引摘要，需要原文重新调用即可
- 多文件修改合并为一轮（edit_project_file 一次传多文件 edits，参数结构见工具清单）
- oldText 必须从 read 结果逐字复制（含缩进）；失败时按返回的最接近片段+行号照抄重试
- 写操作幂等：发送/提交/创建类操作执行一次后，若验证手段不可用，只能用无副作用方式核验（截图/读状态/读回显）`,

  // 🔥 排列顺序优化缓存命中率：固定前缀尽可能长
  // staticEnvironment（固定）→ executionHistory（早期round可命中）→ dynamicEnvironment（动态）→ 轮次（动态）
  reactPromptTemplate: `{staticEnvironment}

{executionHistory}

{dynamicEnvironment}

轮次: {roundNumber}/{maxRounds} | 剩余: {remainingRounds}
⚠️请仔细参考执行历史，切勿重复执行操作。
⚠️请遵从systemprompt的格式返回JSON，不要包含其他文本。`,
};

/**
 * 构建环境上下文文本
 */
function buildEnvironmentContext(relevantFiles: any[]): string {
  if (!relevantFiles?.length) {
    return '';
  }
  return `相关文件:\n${relevantFiles.map((f: any) => `- ${f.path}`).join('\n')}\n\n`;
}

/**
 * 🔥 从 writeNotes 中按 Round 拆分出每轮的笔记
 * writeNotes 格式: "【Round 1 笔记】\nxxx\n---\n【Round 2 笔记】\nxxx"
 * 返回 Map<roundNumber, noteContent>
 */
function parseNotesByRound(writeNotes?: string): Map<number, string> {
  const notesMap = new Map<number, string>();
  if (!writeNotes) return notesMap;

  const segments = writeNotes.split(/\n---\n/);
  for (const segment of segments) {
    const match = segment.match(/【Round (\d+) 笔记】\n?([\s\S]*)/);
    if (match) {
      const roundNum = parseInt(match[1], 10);
      const content = match[2].trim();
      if (content) {
        notesMap.set(roundNum, content);
      }
    }
  }
  return notesMap;
}

/**
 * 🔥 构建执行历史文本（按 Round 堆叠，笔记和执行记录内聚，优化缓存命中率）
 * 截断/折叠逻辑统一在此处理：
 * - clearWindow 即折叠批次大小：常规归档边界按批次对齐移动，两次移动之间历史纯追加，保住缓存前缀
 * - 窗口内梯度预算：当前块单条 30k / 次新块单条 8k（只影响超限条目，短结果渲染不变）
 * - 🔥 动态防护（体积超 maxHistoryChars 时由温和到暴力逐级压缩，压缩级棘轮只升不降）：
 *   L1 最早一批提前归档 → L2 只留当前一批 → L3 当前批内收紧单条预算 → 最终尾部截断兜底
 * @param clearWindow 折叠批次大小（从 ReActService.ts 传入）
 * @param writeNotes 累积的工作笔记，按 Round 拆分后与执行记录合并
 * @param maxHistoryChars 执行历史体积预算（字符），超出触发梯度压缩
 * @param sessionId 会话标识（压缩级棘轮按 session 记忆，可选）
 */
interface ToolResultItem {
  toolName: string;
  parameters: Record<string, any>;
  /** 🔥 真实轮号（executor push 时写入）：折叠行内容只由条目自身决定，历史窗口平移后内容仍不变 */
  roundNumber?: number;
  /** 🔥 主动归档标记（LLM 传 archive=true 后由 executor 写入）：无论是否在批次边界，渲染为索引摘要行 */
  archived?: boolean;
  result: {
    success: boolean;
    data?: any;
    error?: string;
  };
}

/**
 * 🔥 params 智能瘦身渲染：长字符串字段内截（保字段结构+开头），整体预算 400。
 * 替代原 100 字符硬截——大字段（如 edit 的 oldText/newText）会把 filePath 等
 * 有价值的元信息挤出截断窗口，产出纯噪音碎片。query 由调用方完整保留。
 */
function renderParams(params: Record<string, any> | undefined, budget = 400): string {
  if (!params || typeof params !== 'object') return '';
  const slim = JSON.stringify(params, (_k, v) =>
    typeof v === 'string' && v.length > 80
      ? v.substring(0, 60) + `…[共${v.length}字符]`
      : v
  );
  return slim.length > budget ? slim.substring(0, budget) + '…' : slim;
}

/**
 * 🔥 折叠归档行的内容索引摘要
 * 让 LLM 看归档就能判断"是否需要重新执行"：
 * - JSON 数组结果（搜索/列表类）：提取前 3 项的标题/URL 字段 → 知道搜到过什么，不再盲目重搜
 * - 其他结果：去空白后前 200 字符
 * 统一附总字符数 + 重调提示（原文不保留在历史里，重调工具即重新执行）
 */
function digestArchivedResult(resultData: string): string {
  let digest = '';
  try {
    const parsed = JSON.parse(resultData);
    const arr = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.results) ? parsed.results
      : Array.isArray(parsed?.data) ? parsed.data
      : null;
    if (arr && arr.length > 0) {
      digest = arr.slice(0, 3).map((item: any) => {
        if (typeof item !== 'object' || item === null) return String(item).substring(0, 60);
        const title = item.title || item.name || '';
        const url = item.url || item.link || '';
        return [title, url].filter(Boolean).join(' | ') || JSON.stringify(item).substring(0, 60);
      }).join(' ;; ');
    }
  } catch { /* 非 JSON，走通用截取 */ }
  if (!digest) {
    digest = resultData.replace(/\s+/g, ' ').trim().substring(0, 200);
  }
  return `[已归档，共 ${resultData.length} 字符] ${digest}${digest.length >= 200 ? '…' : ''}（需要完整内容请重新调用该工具）`;
}

/**
 * 🔥 渲染执行历史主体（梯度预算：内容越新价值越高，单条预算越宽裕）
 * 轮次块内只放执行记录，笔记统一在 buildNotesSection 集中渲染（跨轮累积、穿越归档周期）
 * @param archStart   归档边界：< archStart 折叠为归档行（批次对齐）
 * @param recentStart 大预算边界：>= recentStart 用 maxRecentChars（当前块，最新鲜），
 *                    [archStart, recentStart) 用 maxOlderChars（次新块）
 * 关键性质：预算档位只影响超限条目的渲染——短结果在各档下渲染完全相同，
 * 因此梯度不引入额外断点，只有真正的大结果被收紧时才在其所在批次处断点
 */
function renderRounds(
  toolResults: ToolResultItem[],
  archStart: number,
  recentStart: number,
  maxRecentChars: number,
  maxOlderChars: number
): string {
  return toolResults
    .map((tool, index) => {
      // 🔥 优先用真实轮号：不用 index 重编号，避免历史窗口平移后折叠行内容每轮变化
      const roundNum = tool.roundNumber ?? index + 1;
      const paramsStr = tool.parameters?.query
        ? `"${tool.parameters.query}"`
        : renderParams(tool.parameters);
      let resultData = tool.result?.success
        ? (typeof tool.result.data === 'string' ? tool.result.data : JSON.stringify(tool.result.data))
        : (tool.result?.error || '执行失败');

      // 🔥 归档边界外的旧轮次 / 被 LLM 主动归档的条目：折叠为归档行（带内容索引摘要）。
      // 纯"已折叠，详见笔记"会让 LLM 失去判断依据——尤其搜索类结果，不知道搜到过
      // 什么 URL/标题就会盲目重搜（连续十几轮耗在搜索上的直接原因）。
      // 必须在预算截断之前做，digest 用的是原始完整长度
      if (index < archStart || tool.archived) {
        return `--- Round ${roundNum} ---\n工具: ${tool.toolName || 'unknown'} 参数: ${paramsStr}\n结果: ${digestArchivedResult(resultData)}\n`;
      }

      // 🔥 梯度单条预算：当前块（最新鲜）宽裕、次新块收紧
      const budget = index >= recentStart ? maxRecentChars : maxOlderChars;
      if (resultData.length > budget) {
        resultData = resultData.substring(0, budget) +
          `\n...[结果已截断，原始大小 ${resultData.length} 字符。如需完整内容请重新调用工具]`;
      }

      return `--- Round ${roundNum} ---\n` +
        `工具: ${tool.toolName || 'unknown'}\n` +
        `参数: ${paramsStr}\n` +
        `结果: ${resultData}\n`;
    })
    .join('\n');
}

/**
 * 🔥 工作笔记集中区（跨轮累积，穿越归档周期）
 * 笔记是关键信息唯一存留处（历史轮次结果归档后仅剩索引摘要，原文需重调工具获取），
 * 因此笔记不随轮次归档丢失，而是集中在执行历史末尾独立渲染：
 * - 未归档轮次笔记：完整保留
 * - 已归档轮次笔记：按预算保留最近的（更早的关键结论通常已被后续笔记延续整合）
 */
function buildNotesSection(
  toolResults: ToolResultItem[],
  notesByRound: Map<number, string>,
  archStart: number
): string {
  if (!notesByRound.size) return '';

  // 归档轮集合（与 renderRounds 的归档判断一致）
  const archivedRounds = new Set<number>();
  toolResults.forEach((t, i) => {
    if (i < archStart || t.archived) archivedRounds.add(t.roundNumber ?? i + 1);
  });

  const active: string[] = [];
  const archived: string[] = [];
  for (const [rn, note] of notesByRound) {
    const line = `【Round ${rn} 笔记】${note}`;
    if (archivedRounds.has(rn)) archived.push(line);
    else active.push(line);
  }

  // 归档笔记预算：超了从最老开始丢，保留最近的
  const MAX_ARCHIVED_NOTES_CHARS = 3000;
  let archText = archived.join('\n');
  if (archText.length > MAX_ARCHIVED_NOTES_CHARS) {
    const kept: string[] = [];
    let size = 0;
    for (let i = archived.length - 1; i >= 0; i--) {
      if (size + archived[i].length > MAX_ARCHIVED_NOTES_CHARS) break;
      kept.unshift(archived[i]);
      size += archived[i].length + 1;
    }
    archText = `[更早轮次笔记已省略，重要结论请在新笔记中延续]\n${kept.join('\n')}`;
  }

  if (!active.length && !archText) return '';
  let section = '\n📋 工作笔记（跨轮累积；归档轮次结果仅剩索引，这里是关键信息唯一存留处）:\n';
  if (active.length) section += `${active.join('\n')}\n`;
  if (archText) section += `${archText}\n`;
  return section;
}

/**
 * 🔥 压缩级别棘轮（按 session 记忆已激活的最高压缩级）：
 * 执行历史体积只增不减，压缩一旦激活就不回落——避免"压了又恢复"导致
 * 历史内容反复变化（每次变化都是一次 cache 断点，且 LLM 会困惑）
 */
const compressionLevels = new Map<string, number>();

/** 🔥 自动归档推进监控（按 session 记忆上次归档累计数，边界前移时打一条精简 log） */
const archivedCounts = new Map<string, number>();

function buildExecutionHistory(
  toolResults: ToolResultItem[],
  clearWindow: number = 1,
  writeNotes?: string,
  maxHistoryChars: number = 36000,
  sessionId?: string
): { text: string; autoArchived: number } {
  if (!toolResults.length && !writeNotes) {
    return { text: '', autoArchived: 0 };
  }

  // 🔥 按 Round 拆分笔记
  const notesByRound = parseNotesByRound(writeNotes);

  // 🔥 批次大小固定 = clearWindow：所有压缩边界均按批次对齐移动，
  // 两次压缩之间历史纯追加，cache 前缀全程命中
  const BATCH = Math.max(1, clearWindow);
  const total = toolResults.length;
  const overflow = Math.max(0, total - clearWindow);
  const baseArch = Math.floor(overflow / BATCH) * BATCH;          // 常规归档边界（批次对齐）
  const curBlockStart = Math.floor((total - 1) / BATCH) * BATCH;  // 当前块起点（最新鲜的一批）

  // 🔥 自动归档推进 log（边界前移才打，一条/次）：主动归档的 log 在前端 ReActExecutor
  if (sessionId && baseArch > (archivedCounts.get(sessionId) ?? 0)) {
    const prev = archivedCounts.get(sessionId) ?? 0;
    console.log(`[REACT-PROTOCOL] 📦 自动归档推进: +${baseArch - prev} 条（累计 ${baseArch}/${total}，批次=${BATCH}）`);
    if (archivedCounts.size > 500) archivedCounts.clear();
    archivedCounts.set(sessionId, baseArch);
  }

  // 🔥 梯度单条预算：当前块宽裕、次新块收紧。只影响超限条目——短结果在各档下
  // 渲染完全相同，不引入额外断点（如 1.8 万字符的读取 < 3 万放行，多条累加
  // 爆整包预算时才逐级收紧）
  // 🔥 2026-10 下调：排队型模型（glm-5.3-flash）prompt ~58KB/2万 token 时单轮 3 分钟+（实测
  // Round 4 耗时 197s），且整轮 = 历史预算 + 固定环境（工具清单等 ~13KB），历史预算须为固定部分留量，
  // 让整轮落在 18k token 内。36000 + 13000 固定 ≈ 49KB ≈ 16.8k token
  const MAX_RECENT_CHARS = 18000;
  const MAX_OLDER_CHARS = 6000;

  // 🔥 压缩梯度：由温和到暴力逐级尝试，体积达标即停
  // （每级一次纯字符串渲染，几十 KB 级微秒开销，无性能问题）
  // L0 常态：常规归档边界 + 梯度预算（当前块 30k / 次新块 8k）
  // L1 最早一批提前归档（最老内容最先牺牲，当前上下文无损）
  // L2 只保留当前一批完整结果
  // L3 当前批内也收紧（单批内容自身超预算的极端场景，保体积优先）
  const rawLevels: Array<{ arch: number; recent: number; maxRecent: number; maxOlder: number; note: string }> = [
    { arch: baseArch, recent: curBlockStart, maxRecent: MAX_RECENT_CHARS, maxOlder: MAX_OLDER_CHARS, note: '' },
    { arch: Math.min(baseArch + BATCH, curBlockStart), recent: curBlockStart, maxRecent: MAX_RECENT_CHARS, maxOlder: MAX_OLDER_CHARS, note: '最早一批历史已提前归档' },
    { arch: curBlockStart, recent: curBlockStart, maxRecent: MAX_RECENT_CHARS, maxOlder: MAX_OLDER_CHARS, note: '仅保留最近一批完整结果，更早轮次已归档' },
    { arch: curBlockStart, recent: curBlockStart, maxRecent: MAX_OLDER_CHARS, maxOlder: MAX_OLDER_CHARS, note: '单条结果预算已收紧' },
  ];
  // 去重相邻参数完全相同的级（如不足两批时 L1/L2 与 L0 等价），避免无效渲染
  const levels = rawLevels.filter((lv, i) => {
    if (i === 0) return true;
    const prev = rawLevels[i - 1];
    return lv.arch !== prev.arch || lv.recent !== prev.recent || lv.maxRecent !== prev.maxRecent || lv.maxOlder !== prev.maxOlder;
  });

  // 🔥 棘轮下限：本 session 已激活过的最高压缩级（防体积波动导致"压了又恢复"）
  const prevLevel = sessionId ? (compressionLevels.get(sessionId) ?? 0) : 0;

  let body = '';
  let chosenIdx = levels.length - 1;
  for (let i = Math.min(prevLevel, levels.length - 1); i < levels.length; i++) {
    const lv = levels[i];
    body = renderRounds(toolResults, lv.arch, lv.recent, lv.maxRecent, lv.maxOlder);
    chosenIdx = i;
    if (body.length <= maxHistoryChars) break;
  }
  if (sessionId) {
    if (compressionLevels.size > 500) compressionLevels.clear(); // 防 Map 无界增长
    compressionLevels.set(sessionId, Math.max(prevLevel, chosenIdx));
  }

  // 🔥 最终兜底：最高压缩级仍超预算（极端超长会话），整体尾部截断
  if (body.length > maxHistoryChars) {
    body = `…[执行历史超长，最早部分已截断]\n` + body.slice(body.length - maxHistoryChars);
  }

  let header = '';
  if (total) {
    // 🔥 header 固定写 clearWindow 配置值（不用动态数字），保证 header 每轮完全一致
    header = `执行历史（仅保留最近 ${clearWindow} 轮完整结果，请勤快记录笔记防止重要内容丢失）:\n`;
  }

  // 🔥 压缩激活时告知 LLM 原因与建议。放在历史末尾：出现/消失只影响末段前缀
  let footer = '';
  const chosen = levels[chosenIdx];
  if (chosen?.note) {
    footer = `\n⚠️ 注意：${chosen.note}。建议缩小读取范围（如分段读取文件、限制返回条数），并勤快记录笔记保存关键信息，避免反复获取大体积内容。`;
  }

  // 🔥 归档节奏提示（历史末尾，每轮数字变化只影响末段，cache 友好）
  let rhythm = '';
  if (total) {
    const overflowNow = Math.max(0, total - clearWindow);
    const nextBoundary = (Math.floor(overflowNow / BATCH) + 1) * BATCH;
    const remainToAutoArch = Math.max(0, nextBoundary - overflowNow);
    rhythm = `\n📊 离下次自动归档还有 ${remainToAutoArch} 轮 | 当前块 ${MAX_RECENT_CHARS} 字符 | 总预算 ${maxHistoryChars} 字符`;
  }

  // 🔥 工作笔记集中区：放在 body 之后（每轮新笔记只追加末段，cache 友好）
  const notesSection = buildNotesSection(toolResults, notesByRound, levels[chosenIdx]?.arch ?? baseArch);

  return { text: header + body + notesSection + footer + rhythm, autoArchived: baseArch };
}

export const ReActProtocols = {
  STANDARD: STANDARD_REACT_PROTOCOL,

  /**
   * 获取 ReAct 协议
   * @param mode 协议模式
   */
  get: (mode: 'standard' = 'standard'): ReActProtocolConfig => {
    return mode === 'standard' ? STANDARD_REACT_PROTOCOL : STANDARD_REACT_PROTOCOL;
  },

  /**
   * 构建 ReAct Prompt
   */
  buildPrompt: (params: {
    roundNumber: number;
    maxRounds: number;
    userQuery: string;
    letAgentTodo: string;
    relevantFiles: any[];
    toolResults: Array<{
      toolName: string;
      parameters: Record<string, any>;
      roundNumber?: number;
      result: {
        success: boolean;
        data?: any;
        error?: string;
      };
    }>;
    environmentText?: string;
    /** 🔥 固定部分环境文本（ExecutionTools、UserPC 等，每轮不变） */
    staticEnvironmentText?: string;
    /** 🔥 动态部分环境文本（ImportantObjects、UserInjectMessages 等，可能每轮变化） */
    dynamicEnvironmentText?: string;
    writeNotes?: string;
    clearWindow?: number; // 🔥 折叠批次大小
    maxHistoryChars?: number; // 🔥 执行历史体积预算（字符），超出自动梯度压缩
    sessionId?: string; // 🔥 会话标识（压缩级棘轮按 session 记忆，可选）
  }): {
    systemPrompt: string;
    userPrompt: string;
    /** 🔥 prompt 分项体积（字符）：executionHistory / staticEnv / dynamicEnv，用于每轮体积归因 */
    parts: { history: number; staticEnv: number; dynamicEnv: number; autoArchived: number };
  } => {
    const { roundNumber, maxRounds, userQuery, letAgentTodo, relevantFiles, toolResults, environmentText, staticEnvironmentText, dynamicEnvironmentText, writeNotes, clearWindow = 1, maxHistoryChars = 36000, sessionId } = params;

    const { text: executionHistory, autoArchived } = buildExecutionHistory(toolResults, clearWindow, writeNotes, maxHistoryChars, sessionId);
    const remainingRounds = maxRounds - roundNumber;

    // 🔥 letAgentTodo 放在 systemPrompt 中，同一 session 内 Round 1→2→3 的 systemPrompt 完全相同，提高缓存命中率
    const systemPrompt = STANDARD_REACT_PROTOCOL.systemPrompt
      .replace('{letAgentTodo}', letAgentTodo);

    // 🔥 环境文本拆分：static 在 executionHistory 前（可缓存），dynamic 在 executionHistory 后
    const staticEnv = staticEnvironmentText || '';
    const dynamicEnv = dynamicEnvironmentText || environmentText || buildEnvironmentContext(relevantFiles);

    const userPrompt = STANDARD_REACT_PROTOCOL.reactPromptTemplate
      .replace('{roundNumber}', String(roundNumber))
      .replace('{maxRounds}', String(maxRounds))
      .replace('{remainingRounds}', String(remainingRounds))
      .replace('{staticEnvironment}', staticEnv)
      .replace('{dynamicEnvironment}', dynamicEnv)
      .replace('{executionHistory}', executionHistory);

    // 🔥 prompt 体积监控：超过 200KB 说明有内容异常膨胀（正常 1-2 万 token ≈ 40-80KB）
    const promptSize = systemPrompt.length + userPrompt.length;
    if (promptSize > 200 * 1024) {
      console.warn(`⚠️ [REACT-PROTOCOL] Round ${roundNumber} prompt 异常庞大: ${(promptSize / 1024).toFixed(0)}KB ` +
        `(staticEnv=${(staticEnv.length / 1024).toFixed(0)}KB dynamicEnv=${(dynamicEnv.length / 1024).toFixed(0)}KB ` +
        `executionHistory=${(executionHistory.length / 1024).toFixed(0)}KB)`);
    }

    return {
      systemPrompt,
      userPrompt,
      parts: {
        history: executionHistory.length,
        staticEnv: staticEnv.length,
        dynamicEnv: dynamicEnv.length,
        autoArchived,
      },
    };
  },
};
