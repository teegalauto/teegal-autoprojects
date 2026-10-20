/**
 * RoundMemory - 回合切分与骨架渲染（对话历史 与 记忆回忆 call_memory 共用的核心模块）
 *
 * 回合（Round）定义：一条 userquery（role=user 且无 sessionId 且无注入标记；
 * interaction 回复带 sessionId、process 内追加的消息带 `---✅ 消息已加入队列`，均不算回合起点）
 * + 它引发的全部消息。
 *
 * 职责：
 * 1. splitRounds: 把时序消息数组切分为回合单元
 * 2. renderRoundLines: 把回合渲染为消息行（历史回合 summarizer 截 20 字 + 📋 memory 快照、
 *    当前回合全量、reactor 按 sessionId 折叠、代码块截断可选）
 *
 * 架构考虑：本模块是纯计算（数据源无关）。输入消息数组统一 camelCase 字段
 * （content/result/memory/sessionId/apiRole/timestamp），由调用方完成 DB snake_case 的归一化。
 * 未来全表回忆（跨会话 index 检索）只需更换数据源，切分与渲染逻辑复用此处。
 */

// ============ 配置 ============

/** 历史回合 summarizer 正文保留字数（保交互骨架，大头无效益） */
const SUMMARIZER_KEEP_CHARS = 20;

/** reactor 折叠摘要字数 */
const REACTOR_SUMMARY_CHARS = 50;

/** 代码块截断长度（首尾各半） */
const CODE_BLOCK_MAX = 600;

// ============ 工具 ============

/**
 * 🔥 截断消息中 ```代码块``` 的内部内容，保留首尾各 maxCodeLen/2 字符。
 * 非代码文本不动；短代码块不截断。
 */
export function truncateCodeBlocks(text: string, maxCodeLen = CODE_BLOCK_MAX): string {
  if (!text) return text;
  return text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const trimmed = code.replace(/^\n+/, '').replace(/\n+$/, '');
    if (trimmed.length <= maxCodeLen) return match;
    const half = Math.floor(maxCodeLen / 2);
    const omitted = trimmed.length - maxCodeLen;
    return '```' + lang + '\n' + trimmed.slice(0, half) + '\n...[已截断 ' + omitted + ' 字符]...\n' + trimmed.slice(-half) + '```';
  });
}

/** 注入标记：process 进行中用户追加的消息（持久化到 DB，内存/DB 的 content 都带此前缀） */
const INJECT_MARKER = '---✅ 消息已加入队列';

/** 是否为 process 内注入消息（用户在处理过程中追加的，不是回合起点） */
export function isInjectedMessage(msg: any): boolean {
  return typeof msg?.content === 'string' && msg.content.includes(INJECT_MARKER);
}

/** 消息时间戳归一化（number | Date | string | undefined → ms） */
export function msgTime(msg: any): number {
  const raw = msg.timestamp ?? msg.created_at;
  if (typeof raw === 'number') return raw;
  const t = raw ? new Date(raw).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

// ============ 回合切分 ============

/** 回合单元：一条 userquery + 它引发的全部消息 */
export interface RoundUnit {
  /** 回合内消息（时序，含起点 userquery 消息本身） */
  messages: any[];
  /** 起点 userquery 全文（前置孤儿回合为空串） */
  userQuery: string;
  startTime: number;
  endTime: number;
}

/**
 * 把时序消息数组切分为回合。
 * 回合起点（标记线）= role=user 且无 sessionId（interaction 回复带 sessionId）且无注入标记
 * （`---✅ 消息已加入队列`，process 内追加）；起点之前的孤儿消息归入一个无 userquery 的前置回合。
 * 回合开始时间 = 标记线消息时间；结束时间 = 下一条标记线开始时间的前一条消息时间。
 * 注意：调用前请先完成过滤（只留 user/auto、剔除 streaming/空消息）与时序排序。
 */
export function splitRounds(messages: any[]): RoundUnit[] {
  const rounds: RoundUnit[] = [];
  let current: RoundUnit | null = null;

  for (const msg of messages) {
    const t = msgTime(msg);
    if (msg.role === 'user' && !msg.sessionId && !isInjectedMessage(msg)) {
      current = {
        messages: [msg],
        userQuery: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
        startTime: t,
        endTime: t,
      };
      rounds.push(current);
    } else {
      if (!current) {
        current = { messages: [], userQuery: '', startTime: t, endTime: t };
        rounds.push(current);
      }
      current.messages.push(msg);
      current.endTime = t;
    }
  }

  return rounds;
}

// ============ 回合渲染 ============

/** 渲染后的历史行（与对话历史契约一致） */
export interface RenderedLine {
  role: 'user' | 'assistant';
  content: string;
  sessionId?: string;
  apiRole?: string;
  timestamp: number;
}

export interface RenderRoundOptions {
  /** 当前回合（最后一个回合）：全量展示，summarizer 不截断、不挂 📋 */
  currentRound?: boolean;
  /** 相邻回合（最近完成的历史回合）：summarizer 全文保留（防方案细节丢失，如待确认的 A/B/C 档定义），仍挂 📋 */
  fullSummarizer?: boolean;
  /** 是否对非 summarizer 内容做代码块截断（对话历史=true；记忆回忆=false，保靶点细节） */
  truncateCode?: boolean;
  /** 单条消息 result 的字符预算（undefined=不截）；超限时首尾各半保留，中间标注省略字符数。
   *  用于记忆回忆场景的回合总预算控制：调用方按（总预算 - userquery - memory - summarizer）÷ reactor 条数均摊 */
  maxResultChars?: number;
  /** 是否折叠 reactor（带 sessionId 的 auto 消息合并成一条摘要）。
   *  对话历史=true（保密度）；记忆回忆=false（完全展开，逐条渲染，result 受 maxResultChars 预算控制） */
  foldReactor?: boolean;
}

/**
 * 渲染单个回合为消息行序列：
 * - 历史回合：summarizer 正文截 20 字，回合末条带 memory 的 summarizer 消息挂 📋 快照
 * - 当前回合：全量
 * - reactor（带 sessionId 的 auto 消息）按 sessionId 折叠成一条
 * - 输出按时间排序
 */
export function renderRoundLines(round: RoundUnit, opts: RenderRoundOptions = {}): RenderedLine[] {
  const { currentRound = false, fullSummarizer = false, truncateCode = true, maxResultChars, foldReactor = true } = opts;

  // 📋 快照锚点：本回合最后一条带 memory 的 summarizer 消息（当前回合故意不挂——快照可能尚未产生）
  let anchorIdx = -1;
  let anchorMem = '';
  if (!currentRound) {
    round.messages.forEach((msg, i) => {
      if (msg.apiRole === 'summarizer' && msg.memory) {
        anchorIdx = i;
        anchorMem = msg.memory;
      }
    });
  }

  // 逐消息渲染
  const lines: RenderedLine[] = [];
  round.messages.forEach((msg, i) => {
    const role: 'user' | 'assistant' = msg.role === 'auto' ? 'assistant' : 'user';

    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    const resultStr = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result || '');

    // result 字符预算截断（首尾各半，中间标注省略数）——记忆回忆场景的回合总预算控制
    let resultText = resultStr;
    if (maxResultChars && resultStr.length > maxResultChars) {
      const half = Math.floor(maxResultChars / 2);
      resultText = `${resultStr.slice(0, half)}\n...[已截断 ${resultStr.length - maxResultChars} 字符]...\n${resultStr.slice(-half)}`;
    }

    let full = contentStr;
    if (resultText && resultText !== 'null' && resultText !== '""') {
      full = contentStr && contentStr.trim() ? `${contentStr}\n\n[执行结果]: ${resultText}` : resultText;
    }

    if (!currentRound && msg.apiRole === 'summarizer') {
      // 历史回合 summarizer：默认截 20 字保骨架；相邻回合（fullSummarizer）保留全文防方案细节丢失。
      // 两种模式都在回合末条挂 📋 笔记快照
      if (!fullSummarizer && full.length > SUMMARIZER_KEEP_CHARS) {
        full = `${full.slice(0, SUMMARIZER_KEEP_CHARS)}…`;
      }
      if (anchorIdx >= 0 && i === anchorIdx) {
        full = `${full}\n📋 ${anchorMem}`;
      }
    } else if (truncateCode) {
      // 代码块截断（记忆回忆场景不截，保靶点细节）
      full = truncateCodeBlocks(full);
    }

    lines.push({
      role,
      content: full,
      sessionId: msg.sessionId,
      apiRole: msg.apiRole,
      timestamp: msgTime(msg),
    });
  });

  // reactor 折叠：带 sessionId 的消息按 sessionId 合并成一条（foldReactor=false 时完全展开，逐条渲染）
  const sessionGroups = new Map<string, RenderedLine[]>();
  const nonSession: RenderedLine[] = [];
  for (const line of lines) {
    if (line.sessionId) {
      if (!sessionGroups.has(line.sessionId)) sessionGroups.set(line.sessionId, []);
      sessionGroups.get(line.sessionId)!.push(line);
    } else {
      nonSession.push(line);
    }
  }

  const out: RenderedLine[] = [...nonSession];
  if (foldReactor) {
    for (const [sessionId, msgs] of sessionGroups) {
      if (msgs.length === 0) continue;
      const first = msgs[0];
      const last = msgs[msgs.length - 1];

      let durationText = '';
      const durationMs = last.timestamp - first.timestamp;
      const seconds = Math.floor(durationMs / 1000);
      const minutes = Math.floor(seconds / 60);
      if (minutes > 0) {
        durationText = `${minutes}m ${seconds % 60}s`;
      } else {
        durationText = `${seconds}s`;
      }

      const summary = last.content.slice(0, REACTOR_SUMMARY_CHARS) + (last.content.length > REACTOR_SUMMARY_CHARS ? '...' : '');
      out.push({
        role: 'assistant',
        content: `[Reactor · ${msgs.length}条 · ${durationText}] ${summary}`,
        sessionId,
        apiRole: 'reactor',
        timestamp: last.timestamp,
      });
    }
  } else {
    // 完全展开：reactor 逐条保留（result 已受 maxResultChars 预算控制）
    for (const [, msgs] of sessionGroups) {
      out.push(...msgs);
    }
  }

  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
