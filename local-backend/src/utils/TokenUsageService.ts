/**
 * TokenUsageService - Token 使用量统计服务
 * 
 * 职责：
 * - 统计每次 LLM 调用的 token 使用量
 * - 按天累加存储到本地 JSON 文件
 * - 提供查询接口
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TokenUsageRecord {
  timestamp: string;
  source: 'react' | 'summary';
  model: string;
  promptTokens: number;
  completionTokens: number;      // 总输出（含 reasoning）
  reasoningTokens?: number;      // 推理思考 token（被丢弃）
  outputTokens?: number;         // 实际输出 = completion - reasoning
  totalTokens: number;
  duration?: number;
  sessionId?: string;
  depth?: number;
  cacheHitTokens?: number;       // 🔥 缓存命中的 token 数
  cacheMissTokens?: number;      // 🔥 缓存未命中的 token 数
}

export interface DailyTokenUsage {
  date: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalDuration: number;
  callCount: number;
  records: TokenUsageRecord[];
}

export interface TokenUsageStats {
  dailyUsages: Record<string, DailyTokenUsage>;
}

/** 🔥 任务级聚合（按 sessionId） */
export interface SessionAggregate {
  sessionId: string;
  firstTimestamp: string;
  lastTimestamp: string;
  reactRounds: number;       // ReAct 轮数（react 记录的最大 depth）
  reactCalls: number;        // reactor 调用次数（含重试轮）
  summaryCalls: number;      // summarizer 调用次数
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number;      // 缓存命中率 0~1
  duration: number;          // LLM 调用累计耗时 ms
}

/**
 * 获取数据文件路径
 * 🔥 使用 USER_DATA_DIR 环境变量（Electron 用户数据目录）
 * 避免写入 C:\Program Files\Teegal\（需要管理员权限）
 */
function getDataFilePath(): string {
  const userDataDir = process.env.USER_DATA_DIR;
  if (userDataDir) {
    // 🔥 Electron 打包环境：使用用户数据目录
    return path.join(userDataDir, 'data', 'token_usage.json');
  }
  // 🔥 开发环境：使用项目目录
  return path.join(__dirname, '../../data/token_usage.json');
}

const DATA_FILE = getDataFilePath();

export class TokenUsageService {
  private static instance: TokenUsageService;
  private stats: TokenUsageStats;

  static getInstance(): TokenUsageService {
    if (!TokenUsageService.instance) {
      TokenUsageService.instance = new TokenUsageService();
    }
    return TokenUsageService.instance;
  }

  private constructor() {
    this.stats = this.loadData();
  }

  /**
   * 加载本地数据
   */
  private loadData(): TokenUsageStats {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const content = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn('[TokenUsageService] 加载数据失败:', error);
    }
    return { dailyUsages: {} };
  }

  /**
   * 保存数据到本地
   */
  private saveData(): void {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.stats, null, 2), 'utf-8');
    } catch (error) {
      console.error('[TokenUsageService] 保存数据失败:', error);
    }
  }

  /**
   * 获取今天的日期字符串
   */
  private getTodayDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /**
   * 记录一次 LLM 调用的 token 使用量
   */
  recordUsage(
    source: 'react' | 'summary',
    model: string,
    usage: { 
      prompt_tokens: number; 
      completion_tokens: number; 
      total_tokens: number;
      completion_tokens_details?: { reasoning_tokens?: number };
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    },
    sessionId?: string,
    depth?: number,
    duration?: number
  ): void {
    const today = this.getTodayDate();
    
    if (!this.stats.dailyUsages[today]) {
      this.stats.dailyUsages[today] = {
        date: today,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalDuration: 0,
        callCount: 0,
        records: []
      };
    }

    const daily = this.stats.dailyUsages[today];
    
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    const outputTokens = usage.completion_tokens - reasoningTokens;
    
    const record: TokenUsageRecord = {
      timestamp: new Date().toISOString(),
      source,
      model,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      reasoningTokens,
      outputTokens,
      totalTokens: usage.total_tokens || 0,
      duration,
      sessionId,
      depth,
      cacheHitTokens: usage.prompt_cache_hit_tokens || 0,
      cacheMissTokens: usage.prompt_cache_miss_tokens || 0,
    };

    daily.records.push(record);
    daily.totalPromptTokens += record.promptTokens;
    daily.totalCompletionTokens += record.completionTokens;
    daily.totalTokens += record.totalTokens;
    daily.totalDuration += duration || 0;
    daily.callCount += 1;

    this.saveData();
  }

  /**
   * 获取指定日期的 token 使用量
   */
  getDailyUsage(date: string): DailyTokenUsage | null {
    return this.stats.dailyUsages[date] || null;
  }

  /**
   * 获取最近 N 天的 token 使用量
   */
  getRecentDays(days: number = 7): DailyTokenUsage[] {
    const result: DailyTokenUsage[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      
      const usage = this.stats.dailyUsages[dateStr];
      if (usage) {
        result.push(usage);
      } else {
        result.push({
          date: dateStr,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          totalDuration: 0,
          callCount: 0,
          records: []
        });
      }
    }

    return result;
  }

  /**
   * 获取总统计
   */
  getTotalStats(): {
    totalDays: number;
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalDuration: number;
    totalCalls: number;
  } {
    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalDuration = 0;
    let totalCalls = 0;

    for (const date of Object.keys(this.stats.dailyUsages)) {
      const daily = this.stats.dailyUsages[date];
      totalTokens += daily.totalTokens;
      totalPromptTokens += daily.totalPromptTokens;
      totalCompletionTokens += daily.totalCompletionTokens;
      totalDuration += daily.totalDuration;
      totalCalls += daily.callCount;
    }

    return {
      totalDays: Object.keys(this.stats.dailyUsages).length,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalDuration,
      totalCalls
    };
  }

  /**
   * 🔥 按 sessionId 聚合任务级统计（每任务轮次/token/缓存命中率）
   * @param days 只统计最近 N 天（含今天）
   */
  getSessionAggregates(days: number = 7): SessionAggregate[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;

    interface Acc {
      sessionId: string;
      firstTimestamp: string;
      lastTimestamp: string;
      reactRounds: number;
      reactCalls: number;
      summaryCalls: number;
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      duration: number;
    }

    const accMap = new Map<string, Acc>();

    for (const date of Object.keys(this.stats.dailyUsages)) {
      if (date < cutoffStr) continue;
      for (const record of this.stats.dailyUsages[date].records) {
        if (!record.sessionId) continue;

        let acc = accMap.get(record.sessionId);
        if (!acc) {
          acc = {
            sessionId: record.sessionId,
            firstTimestamp: record.timestamp,
            lastTimestamp: record.timestamp,
            reactRounds: 0,
            reactCalls: 0,
            summaryCalls: 0,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            duration: 0,
          };
          accMap.set(record.sessionId, acc);
        }

        if (record.timestamp > acc.lastTimestamp) acc.lastTimestamp = record.timestamp;
        if (record.timestamp < acc.firstTimestamp) acc.firstTimestamp = record.timestamp;
        if (record.source === 'react') {
          acc.reactCalls++;
          acc.reactRounds = Math.max(acc.reactRounds, record.depth || 0);
        } else if (record.source === 'summary') {
          acc.summaryCalls++;
        }
        acc.promptTokens += record.promptTokens || 0;
        acc.completionTokens += record.completionTokens || 0;
        acc.reasoningTokens += record.reasoningTokens || 0;
        acc.totalTokens += record.totalTokens || 0;
        acc.cacheHitTokens += record.cacheHitTokens || 0;
        acc.cacheMissTokens += record.cacheMissTokens || 0;
        acc.duration += record.duration || 0;
      }
    }

    return Array.from(accMap.values())
      .map((a) => ({
        sessionId: a.sessionId,
        firstTimestamp: a.firstTimestamp,
        lastTimestamp: a.lastTimestamp,
        reactRounds: a.reactRounds,
        reactCalls: a.reactCalls,
        summaryCalls: a.summaryCalls,
        promptTokens: a.promptTokens,
        completionTokens: a.completionTokens,
        reasoningTokens: a.reasoningTokens,
        totalTokens: a.totalTokens,
        cacheHitRate: (a.cacheHitTokens + a.cacheMissTokens) > 0
          ? a.cacheHitTokens / (a.cacheHitTokens + a.cacheMissTokens)
          : 0,
        duration: a.duration,
      }))
      .sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? 1 : -1));
  }

  /**
   * 🔥 按 conversationId + 时间窗聚合 summary 类调用 token（聊天回合级显示用）
   *
   * summarizer（开局 thinking / 最终报告）的记录键是 conversationId，与 react 记录（键=react sessionId）
   * 键空间不同；前端把每个回合的时间窗 [startTs, endTs] 发过来，这里求落在窗口内的 summary 记录总和。
   * @param windows 最多 100 个窗口，返回数组与窗口顺序一一对应
   */
  getSummaryTokensInWindows(conversationId: string, windows: Array<{ startTs: number; endTs: number }>): number[] {
    // 只扫窗口覆盖到的日期桶，避免全量遍历
    const dayKeys = new Set<string>();
    const toDayKey = (ts: number) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    for (const w of windows) {
      dayKeys.add(toDayKey(w.startTs));
      dayKeys.add(toDayKey(w.endTs));
    }

    const matched: Array<{ ts: number; total: number }> = [];
    for (const date of dayKeys) {
      const daily = this.stats.dailyUsages[date];
      if (!daily?.records) continue;
      for (const r of daily.records) {
        if (r.source === 'summary' && r.sessionId === conversationId) {
          matched.push({ ts: new Date(r.timestamp).getTime(), total: r.totalTokens || 0 });
        }
      }
    }

    return windows.map((w) => {
      let total = 0;
      for (const m of matched) {
        if (m.ts >= w.startTs && m.ts <= w.endTs) total += m.total;
      }
      return total;
    });
  }

  /**
   * 清除指定日期之前的数据（用于清理旧数据）
   */
  clearOldData(beforeDate: string): void {
    for (const date of Object.keys(this.stats.dailyUsages)) {
      if (date < beforeDate) {
        delete this.stats.dailyUsages[date];
      }
    }
    this.saveData();
  }
}

export const tokenUsageService = TokenUsageService.getInstance();