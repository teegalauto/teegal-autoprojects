/**
 * CallMemoryTool - 记忆召回工具
 *
 * 功能：
 * 1. 接收自然语言查询
 * 2. 🔥 主路径（本会话）：回合级检索——按 RoundMemory 的回合骨架切分消息，
 *    四字段（userquery/memory/content/result）加权打分 + 多样性加成 + 时间衰减，取最高分回合
 * 3. 组装输出：回合起止时间 + userquery 全文 + 📋 笔记快照 + 回合骨架 + 🔍 命中靶点摘录
 *    + 命中分布/时间分布，末尾附其他相关回合 index（供 LLM 换关键词精取）
 * 4. 降级路径（跨会话/回合路径无命中）：FTS5 全文搜索 message 表
 * 5. 命中后还原上下文（上下各抓5条），返回 top2 场景
 */

import { ToolApiClient } from '@/utils/ToolApiClient';
import { messageStorage } from '@/services/storage/MessageStorage';
import { splitRounds, renderRoundLines, msgTime, RoundUnit } from './RoundMemory';

// ============================================================================
// 配置常量
// ============================================================================

const STOP_WORDS = new Set([
  // 中文停用词
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很',
  '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '之', '与', '及',
  '或', '但', '而', '因', '于', '把', '被', '让', '向', '从', '对', '给', '为', '以', '可', '能',
  '来', '过', '下', '中', '大', '小', '多', '少', '个', '种', '里', '外', '前', '后', '内', '间',
  '请', '谢谢', '帮忙', '一下', '需要', '想要', '知道', '怎么', '什么', '哪里', '为什么', '如何',
  // 英文基础停用词（保留 URL、download、upload、oss 等关键词）
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'shall',
  // 常见噪声词（保留 file、link、report 等可能出现在 URL 中的词）
  'use', 'test', 'testing', 'next', 'round', 'operation', 'operate', 'action', 'step', 'run',
  'execute', 'perform', 'make', 'get', 'go', 'try', 'check', 'look', 'see', 'find', 'search',
  'query', 'call', 'invoke', 'start', 'begin', 'end', 'finish', 'done', 'ok', 'yes', 'no',
  'help', 'please', 'want', 'need', 'like', 'think', 'know', 'mean', 'say', 'tell', 'ask',
  'computer', 'tool', 'function', 'method', 'api', 'app', 'application', 'system', 'code',
  'folder', 'path', 'dir', 'directory', 'project', 'workspace', 'task', 'job',
  'work', 'working', 'now', 'then', 'here', 'there', 'today', 'yesterday', 'tomorrow',
  'again', 'also', 'still', 'already', 'just', 'only', 'even', 'very', 'really', 'actually',
  'maybe', 'perhaps', 'probably', 'definitely', 'certainly', 'sure', 'right', 'well',
  'good', 'great', 'nice', 'fine', 'bad', 'wrong', 'error', 'issue', 'problem', 'bug',
  'fix', 'solve', 'resolved', 'done', 'complete', 'completed', 'finish', 'finished',
]);

const PHRASE_MATCH_BONUS = 2.5;
const IDENTIFIER_MATCH_BONUS = 3.0;

// 时间衰减：半衰期 30 天（回合级回忆尺度；久远但真实的回忆命中分应能抵抗衰减）
const TIME_DECAY_HALF_LIFE_DAYS = 30;
const TIME_DECAY_LAMBDA = Math.log(2) / (TIME_DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);

// 上下文抓取条数
const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 5;

// 最终返回场景数
const TOP_SCENES = 2;

// ============================================================================
// 回合级检索配置
// ============================================================================

// 四字段权重：userquery 命中=用户要回忆的就是这个回合；memory 是精炼笔记密度最高；result 是执行流水密度最低
const FIELD_WEIGHTS: Record<string, number> = { userquery: 4, memory: 3, content: 2, result: 1 };
const FIELD_LABELS: Record<string, string> = { userquery: '用户问题', memory: '笔记', content: '内容', result: '执行结果' };

// 每字段最多计分的命中条目数（防单字段海量命中刷分）
const FIELD_TOP_ENTRIES = 3;

// 多样性加成系数：命中的不同 token 数越多越可信（命中3个不同词 > 命中1个词100次）
const DIVERSITY_STEP = 0.2;

// 参与打分的 token 上限（parseQuery 的中文滑窗短语可能上百，内存扫描取高权重前 12）
const MAX_SCORING_TOKENS = 12;

// 靶点摘录：关键词前后保留字数、最大条数
const EXCERPT_CHARS = 100;
const MAX_EXCERPTS = 5;

// 末尾 index 附加的相关回合数
const INDEX_ROUNDS = 3;

// ============================================================================
// 类型定义
// ============================================================================

interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  role: string;
  content: string;
  snippet: string;
  createdAt: string;
  baseScore: number;
  matchedToken: string;
  sessionId?: string;
}

interface MemoryScene {
  sceneIndex: number;
  hitMessage: SearchHit;
  contextMessages: Array<{ role: string; content: string; createdAt: string }>;
  combinedScore: number;
}

export interface UnifiedSearchResult {
  source: 'memory';
  content: string;
  relevanceScore: number;
  metadata?: Record<string, any>;
}

export interface CallMemoryRequest {
  query: string;
  userId: string;
  conversationId?: string;
  sessionId?: string;
}

export interface CallMemoryResponse {
  success: boolean;
  results: UnifiedSearchResult[];
  totalCount: number;
  error?: string;
}

/** 回合打分结果 */
interface RoundScore {
  round: RoundUnit;
  /** 未衰减原始分（权重×log计数×多样性） */
  raw: number;
  /** 最终分（含时间衰减） */
  finalScore: number;
  /** 各字段命中条目数 */
  fieldHits: Record<string, number>;
  /** 全部命中条目的时间戳（时间分布统计用） */
  hitTimes: number[];
  /** 命中条目（供靶点摘录） */
  hitMessages: Array<{ field: string; text: string; count: number }>;
  /** 命中的不同 token 数 */
  distinctCount: number;
}

// ============================================================================
// 查询解析
// ============================================================================

interface SearchToken {
  text: string;
  type: 'identifier' | 'phrase' | 'word';
  weight: number;
}

function extractIdentifiers(text: string): string[] {
  // 🔥 匹配带下划线的标识符（如 tsmc_2025_2027）
  const underscoreMatches = text.match(/[a-zA-Z0-9_]+(?:_[a-zA-Z0-9_]+)+/g) || [];
  
  // 🔥 匹配大写缩写词（如 TSMC、OSS、URL、HTML）
  const acronymMatches = text.match(/[A-Z]{2,6}/g) || [];
  
  // 🔥 合并并去重
  return [...new Set([...underscoreMatches, ...acronymMatches])];
}

function extractChinesePhrases(text: string): string[] {
  const phrases: string[] = [];
  const chineseSeq = text.match(/[\u4e00-\u9fa5]{2,6}/g);
  if (chineseSeq) {
    chineseSeq.forEach(seq => {
      for (let i = 0; i < seq.length; i++) {
        for (let len = 2; len <= Math.min(4, seq.length - i); len++) {
          phrases.push(seq.slice(i, i + len));
        }
      }
    });
  }
  return [...new Set(phrases)];
}

function parseQuery(query: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  const seen = new Set<string>();

  const identifiers = extractIdentifiers(query);
  identifiers.forEach(id => {
    if (!seen.has(id)) {
      seen.add(id);
      tokens.push({ text: id, type: 'identifier', weight: IDENTIFIER_MATCH_BONUS });
    }
  });

  const phrases = extractChinesePhrases(query);
  phrases.forEach(ph => {
    if (!seen.has(ph) && !STOP_WORDS.has(ph)) {
      seen.add(ph);
      tokens.push({ text: ph, type: 'phrase', weight: PHRASE_MATCH_BONUS });
    }
  });

  const words: string[] = query.match(/[a-zA-Z][a-zA-Z0-9]{2,}/g) || [];
  words.forEach(w => {
    const lower = w.toLowerCase();
    if (!seen.has(lower) && !STOP_WORDS.has(lower) && !identifiers.includes(w)) {
      seen.add(lower);
      // 英文单词长度越短权重越低，避免短词噪声
      const lengthBoost = Math.min(lower.length / 5, 1.0);
      tokens.push({ text: w, type: 'word', weight: 1.0 * lengthBoost });
    }
  });

  const cleanQuery = query.replace(/[.,;:"'`~^*+=<>@#&|!?()\[\]{}\\/$%_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanQuery.length >= 4 && !seen.has(cleanQuery)) {
    tokens.unshift({ text: cleanQuery, type: 'phrase', weight: PHRASE_MATCH_BONUS * 1.2 });
  }

  return tokens;
}

function escapeFts5(keyword: string): string {
  if (!keyword) return '';
  const specialChars = /[.,;:"'`~^*+=<>@#&|!?()\[\]{}\\/$%-]+/g;
  return keyword.replace(specialChars, ' ').replace(/\s+/g, ' ').trim();
}

// ============================================================================
// 时间衰减与通用工具
// ============================================================================

function applyTimeDecay(baseScore: number, time: string | number): number {
  const msgTimeMs = typeof time === 'number' ? time : new Date(time).getTime();
  const ageMs = Date.now() - msgTimeMs;
  if (ageMs <= 0) return baseScore;

  const decayFactor = Math.exp(-TIME_DECAY_LAMBDA * ageMs);
  return baseScore * decayFactor;
}

/** 子串出现次数 */
function countOccurrences(text: string, needle: string): number {
  if (!text || !needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/** 关键词首个命中位前后 chars 字的摘录 */
function excerptAround(text: string, needles: string[], chars: number): string | null {
  let bestPos = -1;
  for (const t of needles) {
    if (!t) continue;
    const p = text.indexOf(t);
    if (p !== -1 && (bestPos === -1 || p < bestPos)) bestPos = p;
  }
  if (bestPos === -1) return null;
  const start = Math.max(0, bestPos - chars);
  const end = Math.min(text.length, bestPos + chars);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** 时间戳 → 'YYYY-MM-DD HH:mm' */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 命中时间分布分桶：1天内 / 3天内 / 7天内 / 1个月内 / 超过1个月 */
function timeBuckets(times: number[], now: number): string {
  if (times.length === 0) return '';
  const DAY = 24 * 60 * 60 * 1000;
  const defs: Array<[string, number]> = [
    ['1天内', 1],
    ['3天内', 3],
    ['7天内', 7],
    ['1个月内', 30],
    ['超过1个月', Infinity],
  ];
  const counts = defs.map(() => 0);
  for (const t of times) {
    const ageDays = (now - t) / DAY;
    const idx = defs.findIndex(([, maxDays]) => ageDays <= maxDays);
    if (idx >= 0) counts[idx]++;
  }
  return defs
    .map(([label], i) => (counts[i] > 0 ? `${label}${counts[i]}处` : ''))
    .filter(Boolean)
    .join(' / ');
}

// ============================================================================
// 主类
// ============================================================================

export class CallMemoryTool {
  private static instance: CallMemoryTool;

  static getInstance(): CallMemoryTool {
    if (!CallMemoryTool.instance) {
      CallMemoryTool.instance = new CallMemoryTool();
    }
    return CallMemoryTool.instance;
  }

  async callMemory(request: CallMemoryRequest): Promise<CallMemoryResponse> {
    const { query, userId, conversationId, sessionId } = request;

    // 🔥 如果提供了 sessionId，直接返回该 Session 的完整消息
    if (sessionId && conversationId) {
      return this.getSessionMessages(conversationId, sessionId);
    }

    console.log('🧠 [CallMemoryTool] 开始搜索:', { query, userId, conversationId });

    if (!query || query.trim().length === 0) {
      return {
        success: false,
        results: [],
        totalCount: 0,
        error: '请提供搜索关键词（query参数）',
      };
    }

    // 🔥 主路径：回合级检索（本会话高密度：回合打分 + 骨架 + 靶点摘录）
    if (conversationId) {
      const roundResult = await this.searchByRounds(query, conversationId);
      if (roundResult) return roundResult;
      console.log('🧠 [CallMemoryTool] 回合路径无命中/不可用，降级 FTS5');
    }

    try {
      const tokens = parseQuery(query);
      console.log('🧠 [CallMemoryTool] 解析token:', tokens.map(t => `${t.text}(${t.type},w=${t.weight})`));

      if (tokens.length === 0) {
        return {
          success: true,
          results: [],
          totalCount: 0,
          error: `无法从 "${query}" 中提取有效搜索词`,
        };
      }

      // 🔥 策略1: 优先用整句搜索（最符合人类记忆方式）
      let hits = await this.searchWholeQuery(query, userId, conversationId);
      console.log('🧠 [CallMemoryTool] 整句搜索命中:', hits.length, '条');

      // 🔥 策略2: 整句搜不到，才拆词搜索
      if (hits.length === 0) {
        hits = await this.searchHits(tokens, userId, conversationId);
        console.log('🧠 [CallMemoryTool] 拆词搜索命中:', hits.length, '条');
      }

      if (hits.length === 0) {
        return {
          success: true,
          results: [],
          totalCount: 0,
          error: `未找到与 "${query}" 相关的历史记录`,
        };
      }

      // 应用时间衰减
      const scoredHits = hits.map(hit => ({
        ...hit,
        finalScore: applyTimeDecay(hit.baseScore, hit.createdAt),
      })).sort((a, b) => b.finalScore - a.finalScore);

      console.log('🧠 [CallMemoryTool] 衰减后 top5:', scoredHits.slice(0, 5).map(h => ({
        score: h.finalScore.toFixed(3),
        token: h.matchedToken,
        age: Math.round((Date.now() - new Date(h.createdAt).getTime()) / (24 * 3600 * 1000)) + '天',
      })));

      // 取 top 命中，还原上下文，构建场景
      const scenes = await this.buildScenes(scoredHits, TOP_SCENES);

      const results: UnifiedSearchResult[] = scenes.map((scene, idx) => ({
        source: 'memory',
        content: this.formatScene(scene),
        relevanceScore: scene.combinedScore,
        metadata: {
          sceneIndex: idx + 1,
          conversationId: scene.hitMessage.conversationId,
          conversationTitle: scene.hitMessage.conversationTitle,
          hitMessageId: scene.hitMessage.messageId,
          hitRole: scene.hitMessage.role,
          matchedToken: scene.hitMessage.matchedToken,
          sessionId: scene.hitMessage.sessionId,
          contextCount: scene.contextMessages.length,
        },
      }));

      console.log('✅ [CallMemoryTool] 返回场景:', results.length);

      return {
        success: true,
        results,
        totalCount: results.length,
      };

    } catch (error) {
      console.error('❌ [CallMemoryTool] 搜索失败:', error);
      return {
        success: false,
        results: [],
        totalCount: 0,
        error: error instanceof Error ? error.message : '搜索失败',
      };
    }
  }

  /**
   * 🔥 策略1: 整句搜索（优先）
   * 直接用用户的原始 query 去 FTS5 搜索，让 BM25 算相关性
   */
  private async searchWholeQuery(
    query: string,
    userId: string,
    conversationId?: string
  ): Promise<SearchHit[]> {
    const cleaned = escapeFts5(query);
    if (!cleaned || cleaned.length < 3) return [];

    try {
      const searchResult = await ToolApiClient.memory.search({
        keyword: cleaned,
        userId,
        conversationId,
        limit: 20,
      });

      const data = searchResult?.data || searchResult?.results || [];
      const hits: SearchHit[] = [];

      data.forEach((m: any) => {
        const messageId = m.id || m.messageId;
        if (!messageId) return;

        // 整句搜索的得分直接用 FTS5 的 rank（BM25），越小越相关
        // FTS5 rank 是 BM25 分数，值越小表示越相关
        // 转换为正分数：rank 越小，分数越高
        const rawRank = m.rank ?? 0;
        // 🔥 使用 1/(1+|rank|) 转换，确保 rank 越小分数越高，且分数在 0-1 之间
        const baseScore = rawRank === 0 ? 1.0 : 1 / (1 + Math.abs(rawRank));

        hits.push({
          messageId,
          conversationId: m.conversation_id || m.conversationId,
          conversationTitle: m.conversation_title || m.conversationTitle,
          role: m.role,
          content: m.content || '',
          snippet: m.snippet || m.content?.substring(0, 200) || '',
          createdAt: m.created_at || m.createdAt,
          baseScore,
          matchedToken: query,
          sessionId: m.session_id || m.sessionId,
        });
      });

      return hits;
    } catch (e) {
      console.warn('⚠️ [CallMemoryTool] 整句搜索失败:', query, e);
      return [];
    }
  }

  /**
   * 🔥 策略2: 拆词搜索（降级）
   * 整句搜不到时，拆成 token 分别搜索
   */
  private async searchHits(
    tokens: SearchToken[],
    userId: string,
    conversationId?: string
  ): Promise<SearchHit[]> {
    const seenIds = new Set<string>();
    const hits: SearchHit[] = [];
    const sortedTokens = [...tokens].sort((a, b) => b.weight - a.weight);

    // 🔥 分离高权重 token（必须全部搜索）和低权重 token（可跳过）
    const highWeightTokens = sortedTokens.filter(t => t.type === 'identifier' || t.type === 'phrase');
    const lowWeightTokens = sortedTokens.filter(t => t.type === 'word');

    // 🔥 先搜索所有高权重 token（identifier 和 phrase 必须全部搜索）
    for (const token of highWeightTokens) {
      const escaped = escapeFts5(token.text);
      if (!escaped || escaped.length < 2) continue;

      try {
        const phraseKeyword = `"${escaped}"`;

        const searchResult = await ToolApiClient.memory.search({
          keyword: phraseKeyword,
          userId,
          conversationId,
          limit: 15,
        });

        const data = searchResult?.data || searchResult?.results || [];

        data.forEach((m: any) => {
          const messageId = m.id || m.messageId;
          if (!messageId || seenIds.has(messageId)) return;

          seenIds.add(messageId);

          const rawRank = m.rank ?? 0;
          const rankScore = rawRank === 0 ? 1.0 : 1 / (1 + Math.abs(rawRank));
          const baseScore = rankScore * token.weight;
          const lengthFactor = Math.min(token.text.length / 3, 2.0);

          hits.push({
            messageId,
            conversationId: m.conversation_id || m.conversationId,
            conversationTitle: m.conversation_title || m.conversationTitle,
            role: m.role,
            content: m.content || '',
            snippet: m.snippet || m.content?.substring(0, 200) || '',
            createdAt: m.created_at || m.createdAt,
            baseScore: baseScore * lengthFactor,
            matchedToken: token.text,
            sessionId: m.session_id || m.sessionId,
          });
        });

      } catch (e) {
        console.warn('⚠️ [CallMemoryTool] token搜索失败:', token.text, e);
      }
    }

    // 🔥 如果高权重 token 找到足够结果，跳过低权重 token
    if (hits.length >= 20) {
      console.log('🧠 [CallMemoryTool] 高权重 token 已找到足够结果，跳过低权重 token');
      return hits;
    }

    // 🔥 搜索低权重 token（word 类型）
    for (const token of lowWeightTokens) {
      const escaped = escapeFts5(token.text);
      if (!escaped || escaped.length < 2) continue;

      try {
        const searchResult = await ToolApiClient.memory.search({
          keyword: escaped,
          userId,
          conversationId,
          limit: 15,
        });

        const data = searchResult?.data || searchResult?.results || [];

        data.forEach((m: any) => {
          const messageId = m.id || m.messageId;
          if (!messageId || seenIds.has(messageId)) return;

          seenIds.add(messageId);

          const rawRank = m.rank ?? 0;
          const rankScore = rawRank === 0 ? 1.0 : 1 / (1 + Math.abs(rawRank));
          const baseScore = rankScore * token.weight;
          const lengthFactor = Math.min(token.text.length / 3, 2.0);

          hits.push({
            messageId,
            conversationId: m.conversation_id || m.conversationId,
            conversationTitle: m.conversation_title || m.conversationTitle,
            role: m.role,
            content: m.content || '',
            snippet: m.snippet || m.content?.substring(0, 200) || '',
            createdAt: m.created_at || m.createdAt,
            baseScore: baseScore * lengthFactor,
            matchedToken: token.text,
            sessionId: m.session_id || m.sessionId,
          });
        });

        if (hits.length >= 30) break;

      } catch (e) {
        console.warn('⚠️ [CallMemoryTool] token搜索失败:', token.text, e);
      }
    }

    return hits;
  }

  private async buildScenes(
    scoredHits: Array<SearchHit & { finalScore: number }>,
    maxScenes: number
  ): Promise<MemoryScene[]> {
    const scenes: MemoryScene[] = [];
    const usedMessageIds = new Set<string>();

    for (const hit of scoredHits) {
      if (scenes.length >= maxScenes) break;
      if (usedMessageIds.has(hit.messageId)) continue;

      try {
        const ctxResult = await ToolApiClient.memory.getContext({
          conversationId: hit.conversationId,
          messageId: hit.messageId,
          before: CONTEXT_BEFORE,
          after: CONTEXT_AFTER,
        });

        const ctxData = ctxResult?.data || [];
        const contextMessages = ctxData.map((m: any) => ({
          role: m.role,
          content: (m.content || '').substring(0, 800),  // 🔥 增加截断长度，确保 URL 不被截断
          createdAt: m.created_at || m.createdAt,
        }));

        // 标记该场景涉及的消息为已使用（避免重复场景）
        contextMessages.forEach((m: any, idx: number) => {
          if (ctxData[idx]?.id) usedMessageIds.add(ctxData[idx].id);
        });

        scenes.push({
          sceneIndex: scenes.length + 1,
          hitMessage: hit,
          contextMessages,
          combinedScore: hit.finalScore,
        });

      } catch (e) {
        console.warn('⚠️ [CallMemoryTool] 获取上下文失败:', hit.messageId, e);
        // 没有上下文也作为一个场景
        scenes.push({
          sceneIndex: scenes.length + 1,
          hitMessage: hit,
          contextMessages: [],
          combinedScore: hit.finalScore * 0.7,
        });
      }
    }

    return scenes.sort((a, b) => b.combinedScore - a.combinedScore);
  }

  private formatScene(scene: MemoryScene): string {
    const parts: string[] = [];

    parts.push(`【场景 ${scene.sceneIndex}】对话: ${scene.hitMessage.conversationTitle || '未命名对话'}`);
    parts.push(`命中关键词: "${scene.hitMessage.matchedToken}"`);
    if (scene.hitMessage.sessionId) {
      parts.push(`SessionId: ${scene.hitMessage.sessionId}`);
    }
    parts.push('');

    if (scene.contextMessages.length > 0) {
      parts.push('--- 上下文 ---');
      scene.contextMessages.forEach(msg => {
        const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role;
        parts.push(`${roleLabel}: ${msg.content}`);
      });
      parts.push('--- 命中消息 ---');
    }

    const hitRole = scene.hitMessage.role === 'user' ? '用户' : scene.hitMessage.role === 'assistant' ? '助手' : scene.hitMessage.role;
    parts.push(`${hitRole}: ${scene.hitMessage.snippet || scene.hitMessage.content.substring(0, 800)}`);  // 🔥 增加截断长度，确保 URL 不被截断

    return parts.join('\n');
  }

  // ==========================================================================
  // 🔥 回合级检索（主路径）
  // ==========================================================================

  /**
   * 回合级检索：拉全会话消息 → RoundMemory 切回合 → 四字段加权打分 → 最高分回合组装输出。
   * 返回 null 表示无命中/不可用（调用方降级 FTS5）。
   */
  private async searchByRounds(query: string, conversationId: string): Promise<CallMemoryResponse | null> {
    try {
      const raw = await messageStorage.getByConversationId(conversationId, 5000);

      // 字段归一化（DB snake_case → camelCase）+ 过滤 + 时序排序
      const messages = (raw || [])
        .map((m: any) => ({
          role: m.role,
          content: m.content || '',
          result: m.result || '',
          memory: m.memory || '',
          sessionId: m.session_id || m.sessionId,
          apiRole: m.api_role || m.apiRole,
          timestamp: m.timestamp ?? m.created_at,
        }))
        .filter((m: any) => ['user', 'auto'].includes(m.role) && (m.content.trim() || (m.result || '').trim()))
        .sort((a: any, b: any) => msgTime(a) - msgTime(b));
      if (messages.length === 0) return null;

      const rounds = splitRounds(messages);
      if (rounds.length === 0) return null;

      // token 提取（复用 FTS5 路径的解析器），内存打分取高权重前 12
      const tokens = parseQuery(query)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, MAX_SCORING_TOKENS);
      if (tokens.length === 0) return null;

      const scored = this.scoreRounds(rounds, tokens);
      const top = scored[0];
      if (!top || top.finalScore <= 0) return null; // 全无命中 → 降级 FTS5

      console.log('🧠 [CallMemoryTool] 回合打分 top3:', scored.slice(0, 3).map((s) => ({
        time: fmtTime(s.round.startTime),
        score: s.finalScore.toFixed(3),
        raw: s.raw.toFixed(2),
        tokens: s.distinctCount,
        hits: s.fieldHits,
      })));

      // 主回合组装
      const content = this.formatRoundMemory(top, tokens);

      // 末尾 index：其他高分回合（猜你喜欢，供 LLM 换关键词精取）
      const others = scored.slice(1).filter((s) => s.finalScore > 0).slice(0, INDEX_ROUNDS);
      const indexLines = others.map((s, i) => {
        const q = (s.round.userQuery || '(无 userquery)').slice(0, 60);
        return `${i + 1}. 【${fmtTime(s.round.startTime)}】${q}`;
      });
      const full = indexLines.length > 0
        ? `${content}\n\n--- 其他相关回合（如需详情，请换关键词调用 call_memory）---\n${indexLines.join('\n')}`
        : content;

      return {
        success: true,
        results: [
          {
            source: 'memory',
            content: full,
            relevanceScore: top.finalScore,
            metadata: {
              type: 'round',
              conversationId,
              roundStartTime: top.round.startTime,
              roundEndTime: top.round.endTime,
              score: top.finalScore,
              distinctTokens: top.distinctCount,
            },
          },
        ],
        totalCount: 1,
      };
    } catch (e) {
      console.warn('⚠️ [CallMemoryTool] 回合级检索失败，降级 FTS5:', e);
      return null;
    }
  }

  /**
   * 回合打分：
   * roundScore = 多样性加成 × Σ_token Σ_field ( fieldWeight × Σ_top3条目 ( tokenWeight × log(1+命中次数) ) ) × 时间衰减
   * - 每字段取命中次数 top3 条目计分（防单字段海量命中刷分）
   * - 多样性加成：命中的不同 token 数（1 + 0.2×(n-1)），命中多个不同词 > 命中一个词一百次
   * - 时间衰减作用于回合结束时间（半衰期 30 天，久远真实回忆的高分应能抵抗）
   */
  private scoreRounds(rounds: RoundUnit[], tokens: SearchToken[]): RoundScore[] {
    const scored = rounds.map((round) => {
      const fieldHits: Record<string, number> = { userquery: 0, memory: 0, content: 0, result: 0 };
      const hitTimes: number[] = [];
      const hitMessages: Array<{ field: string; text: string; count: number }> = [];
      const distinct = new Set<string>();
      let raw = 0;

      for (const token of tokens) {
        let tokenScore = 0;
        for (const field of ['userquery', 'memory', 'content', 'result']) {
          // 该字段的文本域：userquery 用回合起点全文，其余用回合内每条消息的对应字段
          const entries: Array<{ text: string; time: number }> =
            field === 'userquery'
              ? round.userQuery
                ? [{ text: round.userQuery, time: round.startTime }]
                : []
              : round.messages
                  .map((m) => ({ text: typeof m[field] === 'string' ? m[field] : '', time: msgTime(m) }))
                  .filter((e) => e.text);

          const counts = entries
            .map((e) => ({ ...e, count: countOccurrences(e.text, token.text) }))
            .filter((e) => e.count > 0);
          if (counts.length === 0) continue;

          counts.sort((a, b) => b.count - a.count);
          const top3 = counts.slice(0, FIELD_TOP_ENTRIES);
          tokenScore += FIELD_WEIGHTS[field] * top3.reduce((s, e) => s + token.weight * Math.log(1 + e.count), 0);
          fieldHits[field] += counts.length;
          distinct.add(token.text);
          counts.forEach((e) => hitTimes.push(e.time));
          hitMessages.push({ field, text: counts[0].text, count: counts[0].count });
        }
        raw += tokenScore;
      }

      const diversity = 1 + DIVERSITY_STEP * Math.max(0, distinct.size - 1);
      const finalScore = raw > 0 ? raw * diversity * applyTimeDecay(1, round.endTime) : 0;
      return { round, raw, finalScore, fieldHits, hitTimes, hitMessages, distinctCount: distinct.size };
    });

    return scored.sort((a, b) => b.finalScore - a.finalScore);
  }

  /**
   * 靶点摘录：最高分回合内各字段 top 命中消息，取关键词前后 100 字片段。
   * 骨架抹掉的细节（报错文本、URL、参数值）靠这里找回。
   */
  private buildExcerpts(top: RoundScore, tokens: SearchToken[]): Array<{ field: string; snippet: string }> {
    const needles = tokens.map((t) => t.text);
    const seen = new Set<string>();
    const excerpts: Array<{ field: string; snippet: string }> = [];

    const candidates = [...top.hitMessages].filter((h) => h.field !== 'userquery').sort((a, b) => b.count - a.count);
    for (const h of candidates) {
      const key = `${h.field}:${h.text.substring(0, 50)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const snippet = excerptAround(h.text, needles, EXCERPT_CHARS);
      if (snippet) excerpts.push({ field: h.field, snippet });
      if (excerpts.length >= MAX_EXCERPTS) break;
    }
    return excerpts;
  }

  /**
   * 组装最高分回合输出（完全展开 + 回合总预算）：
   * 起止时间 + userquery 全文 + 📋 笔记快照 + 回合骨架（summarizer 全文、reactor 逐条展开、
   * result 按剩余预算均摊截断）+ 🔍 命中靶点 + 命中分布 + 时间分布
   */
  private formatRoundMemory(top: RoundScore, tokens: SearchToken[]): string {
    const parts: string[] = [];
    parts.push(`【回合回忆】${fmtTime(top.round.startTime)} ~ ${fmtTime(top.round.endTime)}`);
    if (top.round.userQuery) {
      parts.push(`用户问题: ${top.round.userQuery}`);
    }

    // 📋 笔记快照：回合内最后一条带 memory 的 summarizer 消息
    const memMsg = [...top.round.messages].reverse().find((m) => m.apiRole === 'summarizer' && m.memory);
    if (memMsg) {
      parts.push(`📋 笔记快照: ${memMsg.memory}`);
    }

    // 🔥 回合总预算（~2000 token ≈ 6000 字符）：固定部分（userquery/notes/summarizer 全文/reactor 正文）
    // 之外，reactor 的 result 按剩余预算均摊截断（每条 clamp 150~2000 字符，首尾各半保留）
    const ROUND_BUDGET_CHARS = 6000;
    const summarizerChars = top.round.messages
      .filter((m) => m.apiRole === 'summarizer')
      .reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const reactorMsgs = top.round.messages.filter((m) => m.sessionId);
    const reactorContentChars = reactorMsgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const fixedChars =
      top.round.userQuery.length + (memMsg?.memory?.length || 0) + summarizerChars + reactorContentChars;
    const maxResultChars = Math.max(150, Math.min(2000, Math.floor((ROUND_BUDGET_CHARS - fixedChars) / Math.max(1, reactorMsgs.length))));

    // 回合骨架：summarizer 全文、reactor 完全展开（不截代码块，保靶点细节）
    const lines = renderRoundLines(top.round, {
      currentRound: false,
      fullSummarizer: true,
      truncateCode: false,
      foldReactor: false,
      maxResultChars,
    });
    if (lines.length > 0) {
      parts.push('--- 回合骨架 ---');
      lines.forEach((l) => {
        const roleLabel = l.role === 'user' ? '用户' : l.apiRole === 'reactor' ? 'Agent' : '助手';
        parts.push(`${roleLabel}: ${l.content}`);
      });
    }
    console.log(`🧠 [CallMemoryTool] 回合骨架: ${lines.length}行 ${(lines.reduce((s, l) => s + l.content.length, 0) / 1024).toFixed(1)}KB maxResultChars=${maxResultChars} (reactor ${reactorMsgs.length}条, 固定部分${(fixedChars / 1024).toFixed(1)}KB)`);

    // 🔍 命中靶点
    const excerpts = this.buildExcerpts(top, tokens);
    if (excerpts.length > 0) {
      parts.push('--- 命中靶点 ---');
      excerpts.forEach((e) => parts.push(`[${FIELD_LABELS[e.field] || e.field}] ${e.snippet}`));
    }

    // 命中分布 + 时间分布
    const hitDist = Object.entries(top.fieldHits)
      .filter(([, n]) => n > 0)
      .map(([f, n]) => `${FIELD_LABELS[f] || f} ${n}处`)
      .join(' / ');
    if (hitDist) parts.push(`命中分布: ${hitDist}`);
    const timeDist = timeBuckets(top.hitTimes, Date.now());
    if (timeDist) parts.push(`时间分布: ${timeDist}`);

    return parts.join('\n');
  }

  /**
   * 🔥 获取指定 Session 的完整消息列表
   */
  private async getSessionMessages(
    conversationId: string,
    sessionId: string
  ): Promise<CallMemoryResponse> {
    console.log('🧠 [CallMemoryTool] 获取 Session 消息:', { conversationId, sessionId });

    try {
      const result = await ToolApiClient.memory.getSession({ conversationId, sessionId });
      const messages = result?.data || [];

      if (messages.length === 0) {
        return {
          success: true,
          results: [],
          totalCount: 0,
          error: `未找到 Session "${sessionId}" 的消息`,
        };
      }

      // 按时间排序，格式化为对话历史
      const sorted = messages.sort((a: any, b: any) =>
        new Date(a.created_at || a.createdAt).getTime() - new Date(b.created_at || b.createdAt).getTime()
      );

      const lines = sorted.map((m: any) => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role;
        const content = (m.content || '').substring(0, 1000);  // 🔥 增加截断长度，确保 URL 不被截断
        return `${role}: ${content}`;
      });

      const content = [
        `【Session ${sessionId} 完整消息】共 ${messages.length} 条`,
        '',
        ...lines,
      ].join('\n');

      return {
        success: true,
        results: [{
          source: 'memory',
          content,
          relevanceScore: 1.0,
          metadata: {
            type: 'session',
            sessionId,
            conversationId,
            messageCount: messages.length,
          },
        }],
        totalCount: 1,
      };

    } catch (error) {
      console.error('❌ [CallMemoryTool] 获取 Session 消息失败:', error);
      return {
        success: false,
        results: [],
        totalCount: 0,
        error: error instanceof Error ? error.message : '获取 Session 消息失败',
      };
    }
  }
}

export const callMemoryTool = CallMemoryTool.getInstance();

/**
 * 🔥 项目记忆路径：call_memory 传 projectId 时走项目档案
 * 不传 query → 时间倒序翻最近档案（接手项目建立熟悉度）；传 query → 打分×时间衰减定向查
 */
async function executeProjectMemory(
  query: string,
  projectId: string,
  context: { userId: string; conversationId: string }
): Promise<any> {
  try {
    const result = await ToolApiClient.memory.queryProjectMemory({
      userId: context.userId,
      projectId,
      query: query || undefined,
      limit: 5,
    });
    const memories = result?.data || [];
    if (memories.length === 0) {
      // 🔥 空档案放进 data 内容（success=true 时 error 字段可能不渲染给 LLM，导致误判"查了没命中"）
      return {
        success: true,
        data: [{
          source: 'project_memory',
          content: `项目 ${String(projectId).slice(0, 8)} 暂无历史记忆档案（新项目，或历史任务跑在存档功能上线前的版本）。直接看代码即可：list_project_files mode=skeleton 先看结构。`,
          relevanceScore: 1.0,
          metadata: { type: 'project_memory', projectId, empty: true },
        }],
      };
    }
    const lines = memories.map((m: any, i: number) => {
      const t = new Date(m.createdAt);
      const pad = (n: number) => String(n).padStart(2, '0');
      const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
      return `【档案${i + 1}】${time} 任务: ${m.userQuery || '(无 userquery)'}\n${m.writeNote || '(无笔记)'}`;
    });
    // 🔥 总预算（单条上限 4000 × 5 条最坏 2 万字符太肥）：从最新档案装起，装满即停
    const MEMORY_TOTAL_BUDGET = 8000;
    const kept: string[] = [];
    let size = 0;
    let omitted = 0;
    for (const line of lines) {
      if (size + line.length > MEMORY_TOTAL_BUDGET) {
        omitted = lines.length - kept.length;
        break;
      }
      kept.push(line);
      size += line.length + 2;
    }
    const tail = omitted > 0 ? `\n\n（还有 ${omitted} 条更早档案未展开，可带 query 定向查）` : '';
    const head = `【项目记忆档案】项目 ${String(projectId).slice(0, 8)} ${kept.length}/${memories.length} 条${query ? '（按相关度排序）' : '（按时间倒序，最近任务在前）'}\n\n`;
    const content = head + kept.join('\n\n') + tail;
    return {
      success: true,
      data: [{
        source: 'project_memory',
        content,
        relevanceScore: 1.0,
        metadata: { type: 'project_memory', projectId },
      }],
    };
  } catch (e: any) {
    return { success: false, data: [], error: `项目记忆查询失败: ${e?.message || e}` };
  }
}

export async function executeCallMemoryTool(
  step: any,
  sessionIdParam: string,
  context: { userId: string; conversationId: string }
): Promise<any> {
  const params = step.toolParams || {};
  const query = params.query || params.keyword || '';
  const sessionId = params.sessionId || undefined;
  const projectId = params.projectId || params.project_id || undefined;

  // 🔥 项目记忆路径：传了 projectId 走项目档案（短 id 由服务端前缀解析兼容）
  if (projectId) {
    return executeProjectMemory(query, projectId, context);
  }

  const result = await callMemoryTool.callMemory({
    query,
    userId: context.userId,
    conversationId: context.conversationId,
    sessionId,
  });

  return {
    success: result.success,
    data: result.results,
    error: result.error,
  };
}
