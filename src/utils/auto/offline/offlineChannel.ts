/**
 * OfflineChannel - 离线指挥本地通道（邮件远程指挥的客户端取件与执行）—— 缓存队列版
 *
 * homeweb 是哑管道：inbound 透传落库、poll 批量取走、complete 只发回函。
 * 交互闭环全在本地：
 *   - 收到信（正文剥 reply 引用后作为 userQuery；回复类主题是元信息不入指令）入 inbox 缓存队列
 *   - 空闲时取队首开一个新回合（await handleSendMessage 到回合终态 → complete 回函）
 *   - 执行中后续到达的信滞留队列，回合结束后自动成为下一轮（同会话上下文连续，LLM 能接上）
 *   - #取消 控制字分流：中止当前编排（回函走 complete 的 cancelled 模板）
 *
 * 回函正文 = 回合 summarizer（pickLatestSummary，与 ChatUI/headless 同一条编排入口）。
 */

import { logger } from '@/utils/logger';
import { CLOUD_BASE_URL } from '@/config/api';

const STORAGE_KEY = 'offline_command_config';
const STATS_KEY = 'offline_command_stats';

/** 本地持久化配置（设置面板写入，轮询通道读取）。userId = 开启时的账号，换账号登录即失效 */
export interface OfflineLocalConfig {
  enabled: boolean;
  addr: string;
  token: string;
  userId?: string;
}

export function loadOfflineConfig(currentUserId?: string): OfflineLocalConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as OfflineLocalConfig;
    // 🔥 归属校验：配置绑定开启时的账号，换账号登录视为未配置（防跨账号串开关、拿上一账号 token 收信）
    if (currentUserId && cfg.userId !== currentUserId) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveOfflineConfig(cfg: OfflineLocalConfig | null): void {
  try {
    if (cfg) localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* 忽略存储异常 */ }
  window.dispatchEvent(new CustomEvent('offline-config-changed'));
}

/** 今日已完成条数（本地自记，跨天归零；徽标 tooltip 展示） */
export function bumpTodayCount(): number {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const stats = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    const count = stats.date === today ? (stats.count || 0) + 1 : 1;
    localStorage.setItem(STATS_KEY, JSON.stringify({ date: today, count }));
    return count;
  } catch {
    return 1;
  }
}

export function getTodayCount(): number {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const stats = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    return stats.date === today ? (stats.count || 0) : 0;
  } catch {
    return 0;
  }
}

/** 引用剥离：reply 的历史上下文只取用户新写的部分。
 *  特征含纯分隔线（-----/____/*___，覆盖回函自带的"--------"引用块边界与各客户端变体）；
 *  注意 QQ 分隔行是"原始邮件"（原邮件三字不连续！须 原(始)?邮件 才能命中）；
 *  QQ web 回信引用层是裸行"原始邮件"（前导空白、无破折线），单独一个分支命中；
 *  "发自我的iPhone"等设备签名行及其后（引用层）一并剥 */
const QUOTE_BREAK_RE = /^\s*(>|On .+wrote\s*:|在.{1,40}写道\s*:|原(始)?邮件\s*$|[-—]{2,}.*(?:原(始)?邮件|Original|Forwarded|转发)|From\s*:.+@|发自我的|[-—_=*]{4,}\s*$|--\s*$)/i;

export function stripQuote(text: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (QUOTE_BREAK_RE.test(line)) break; // 引用/签名开始，其后全是历史上下文
    kept.push(line);
  }
  // QQ text/plain 部分的 HTML 实体不解码（服务端只对 html 部分解码），保底清一遍（&amp; 最后防双解）
  return kept.join('\n').replace(/&nbsp;/gi, ' ').replace(/&gt;/gi, '>').replace(/&lt;/gi, '<').replace(/&amp;/gi, '&').trim();
}

/** 补捞被引用剥离吃掉的 URL（QQ超大附件/网盘下载块在签名与引用层之后，stripQuote 会整段丢弃）。
 *  链接是执行素材，但只补捞文件分享特征域（FILE_SHARE_URL_RE 白名单）：agent 回函里推荐的外部站
 *  （uguu/litterbox 等）会随 QQ 引用层混进原始正文，全网捞会污染 userQuery。
 *  URL 无可靠终止符，scheme 锚定到空白/明显标点；尾部清洗句读与装饰符，右括号仅不配对时去尾（保护维基类合法括号 URL）。
 *  假 URL 过滤：含连续两点 = 用户手打的省略号引用（https://...），不是真链接；
 *  /up/ 路径 = 本系统发给用户的一次性上传链接（注记里已有，无需重复补捞）。
 *  服务端不掺和正文（上传链接走回函转告），本函数是链接补捞的唯一机制，块追加在用户正文之后 */
/** 文件分享特征域白名单：QQ云附件/各网盘中转页=素材链接的特征形态。与服务端 emailService.FILE_SHARE_URL_RE 同构 */
const FILE_SHARE_URL_RE = /mail\.qq\.com|mail\.163\.com|mail\.126\.com|pan\.baidu\.com|weiyun\.com|alipan\.com|aliyundrive\.com|123pan|lanzou|quark\.cn|189\.cn|139\.com|feishu\.cn|wenshushu\.cn|cowtransfer\.com/i;

/** 与服务端 emailService.CLOUD_LINK_HINT 同文案（客户端自持一份） */
const CLOUD_LINK_HINT = '（注：QQ超大附件/网盘多为登录态中转页，抓不到文件属正常，勿反复重试；小文件请用户改用邮件普通附件，超大文件走系统下发的上传链接，勿推荐外部网盘）';

function salvageUrls(rawBody: string, kept: string): string {
  if (!rawBody) return '';
  const lost: string[] = [];
  for (const m of rawBody.matchAll(/https?:\/\/[^\s<>"'】，。；、]+/g)) {
    let url = m[0].replace(/[.,;:!?'"`|。，；：！？…—）]+$/, '');
    while (url.endsWith(')') && ((url.match(/\(/g) || []).length) < ((url.match(/\)/g) || []).length)) {
      url = url.slice(0, -1);
    }
    if (url.length > 12 && FILE_SHARE_URL_RE.test(url) && !/\.\./.test(url) && !/\/up\//.test(url) && !kept.includes(url) && !lost.includes(url)) lost.push(url);
    if (lost.length >= 5) break;
  }
  return lost.join('\n');
}

/** 通道状态（徽标与设置面板展示用） */
export type OfflinePhase = 'off' | 'listening' | 'executing';

// ============ 上传文件挂起缓存 ============
// 上传通道 done 合成的 [文件上传] 消息不独立开回合（纯文件+直链，为它跑一轮 LLM 是纯 token 浪费）：
// 缓存挂起，拼进下一条真实指令的 userQuery 尾部，agent 带着文件继续原任务。
// localStorage 持久化防丢（文件直链 48h 有效），过期随取随清；上传页本身有成功提示，无需回函

const PENDING_UPLOADS_KEY = 'offline_pending_uploads';
const PENDING_UPLOAD_TTL_MS = 48 * 3600 * 1000;

interface PendingUpload { body: string; ts: number; }

function loadPendingUploads(): PendingUpload[] {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_UPLOADS_KEY) || '[]') as PendingUpload[];
    return list.filter((p) => p?.body && Date.now() - p.ts < PENDING_UPLOAD_TTL_MS);
  } catch { return []; }
}

function savePendingUploads(list: PendingUpload[]): void {
  try { localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
}

function appendPendingUpload(body: string): void {
  const list = loadPendingUploads();
  list.push({ body, ts: Date.now() });
  savePendingUploads(list);
}

/** 取走全部挂起文件块（下一条指令一次性消费，多次上传合并拼接） */
function takePendingUploads(): string {
  const list = loadPendingUploads();
  if (list.length === 0) return '';
  savePendingUploads([]);
  return list.map((p) => p.body).join('\n\n');
}

/** 编排执行器（由接线方注入：与 ChatUI / headless 完全同一入口） */
export interface OfflineHandlers {
  /** 执行一个回合编排（resolve/reject = 回合终态） */
  execute: (userQuery: string) => Promise<void>;
  /** 中止当前编排（#取消 控制字） */
  cancel: () => void;
  /** 回合终态回函正文：只取最后一条 summarizer 总结（邮件端不做聊天流全量回放） */
  getRoundReport: () => string;
}

// ============ 回函正文组装 ============

/**
 * 回合消息流 → 回函正文：只取最后一条 summarizer 总结。
 * 邮件端不做前端聊天流的全量回放（启动条/SubAgent 折叠行/中间轮总结对邮件读者是噪音），
 * summarizer 总结本身是 LLM 写的高密度汇总，一条足够。失败/取消路径不走本函数（summary 空，由邮件模板表达）。
 */
export function buildRoundReport(msgs: any[]): string {
  // 取证日志：回函取错消息时（发了中间轮发言），console 里能看到完整选择过程
  const trace = msgs.map((m: any, i: number) =>
    `[${i}] ${m?.apiRole || m?.role || '?'}/${m?.status || '?'}/${String(m?.result || m?.content || '').length}字`);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.apiRole === 'summarizer') {
      const text = String(m.result || m.content || '').trim();
      if (text) {
        console.log(`📤 [OFFLINE-REPORT] 取第 ${i}/${msgs.length - 1} 条: "${text.slice(0, 40)}…" | 流: ${trace.join(' ')}`);
        return text;
      }
    }
  }
  console.log(`📤 [OFFLINE-REPORT] 空回函 | 流: ${trace.join(' ')}`);
  return '';
}

interface InboxItem {
  mailId: number;
  userQuery: string;
  messageId: string;  // 来信 RFC Message-ID：回函 In-Reply-To 线程锚点（同一邮件会话内往来）
  references: string; // 来信 References 头（祖先链）：回函续上完整链，任何客户端都能归组
  subject: string;    // 来信主题：回函主题原样一致（配合严格主题归组）
}

function notifyPhase(phase: OfflinePhase): void {
  window.dispatchEvent(new CustomEvent('offline-channel-status', { detail: { phase, todayCount: getTodayCount() } }));
}

/** 电源保持：监听期间系统不睡眠（屏幕可关），停用/失效释放。主进程 powerSaveBlocker，经 IPC 调用 */
function setPowerSave(on: boolean): void {
  window.electron?.setOfflinePowerSave?.(on)?.catch?.(() => {});
}

class OfflineChannel {
  private handlers: OfflineHandlers | null = null;
  private userId: string | null = null; // 启动时的账号：loop 内重读配置做归属校验
  private polling = false;       // 轮询循环存活
  private loopGen = 0;           // 循环代际：stop→start 窗口内旧长轮询醒来即退，防双循环（双循环会同信双投递）
  private executing = false;     // 正在执行一个离线回合
  private cancelRequested = false; // 当前回合执行期间收到过 #取消
  private inbox: InboxItem[] = []; // 缓存队列：执行中滞留的信，回合结束依次成新回合

  get phase(): OfflinePhase {
    if (this.executing) return 'executing';
    return this.polling ? 'listening' : 'off';
  }

  /** 启动轮询（幂等；token 重置后循环每轮重读配置自动生效） */
  start(handlers: OfflineHandlers, userId?: string): void {
    if (this.polling) return;
    this.userId = userId || null;
    this.handlers = handlers;
    const cfg = loadOfflineConfig(this.userId);
    if (!cfg?.enabled || !cfg.addr || !cfg.token) {
      logger.info('[OFFLINE-CHANNEL] 未启用，跳过启动');
      return;
    }
    this.loopGen++;
    const gen = this.loopGen;
    this.polling = true;
    setPowerSave(true);
    notifyPhase(this.phase);
    logger.info(`[OFFLINE-CHANNEL] 监听启动: ${cfg.addr}`);
    this.loop(gen);
  }

  /** 停止轮询（停用开关/登出） */
  stop(): void {
    this.loopGen++; // 无条件递增：停用瞬间若有旧长轮询还在飞，醒来即退
    if (!this.polling) return;
    this.polling = false;
    setPowerSave(false);
    notifyPhase(this.phase);
    logger.info('[OFFLINE-CHANNEL] 监听停止');
  }

  /** 轮询主循环：每轮重读配置（token 重置即时生效），异常退避 5s 继续，进程内常驻。
   *  gen = 启动代际：被新一代循环顶替（stop→start）或已停用时立即退出，且不清理全局状态 */
  private async loop(gen: number): Promise<void> {
    while (this.polling && gen === this.loopGen) {
      const cfg = loadOfflineConfig(this.userId ?? undefined);
      if (!cfg?.enabled || !cfg.token) break;
      try {
        const mails = await this.poll(cfg.token);

        // 队列投递：空闲才开新回合（await 到回合终态），执行中收信滞留 inbox 成下一轮
        for (const mail of mails) {
          const query = this.normalizeMail(mail);
          if (query === null) continue; // 控制字已分流 / 无新内容
          this.inbox.push({
            mailId: mail.id,
            userQuery: query,
            messageId: String(mail.messageId || ''),
            references: String(mail.references || ''),
            subject: String(mail.subject || ''),
          });
        }
        logger.info(`[OFFLINE-CHANNEL] 取到 ${mails.length} 封信，队列 ${this.inbox.length} 条`);

        while (this.inbox.length > 0) {
          const item = this.inbox[0];
          await this.runTask(cfg, item);
          this.inbox.shift();
        }
      } catch (e: any) {
        logger.warn('[OFFLINE-CHANNEL] 轮询异常，5s 后重试:', e?.message);
        await this.sleep(5000);
      }
    }
    // 仅自然退出（配置失效/停用）才清理全局状态；被新一代循环顶替时绝不能动 polling/powerSave（会误杀新循环）
    if (gen === this.loopGen) {
      this.polling = false;
      setPowerSave(false); // 配置失效退出循环：同步释放电源保持（stop() 已释放时幂等）
      notifyPhase(this.phase);
    }
  }

  private async poll(token: string): Promise<any[]> {
    const res = await fetch(
      `${CLOUD_BASE_URL}/api/offline/poll?wait=25`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`poll ${res.status}`);
    const data = await res.json();
    return data?.success ? (data.messages || []) : [];
  }

  /** 附件备注：Resend CDN 签名直链拼进 userQuery，LLM 拿 URL 自取（与消息管道 URL 模式一致） */
  private attachmentNote(atts: Array<{ filename?: string; url?: string; size?: number }>): string {
    const lines = atts
      .filter((a) => a?.url)
      .map((a) => {
        const kb = Number(a.size) > 0 ? Number(a.size) / 1024 : 0;
        const sizeText = kb >= 1024 ? `（${(kb / 1024).toFixed(1)}MB）` : kb > 0 ? `（${kb.toFixed(0)}KB）` : '';
        return `- ${a.filename || 'attachment'}${sizeText}: ${a.url}`;
      });
    if (lines.length === 0) return '';
    return `\n\n[附件]（链接有时效）：\n${lines.join('\n')}`;
  }

  /**
   * 邮件规范化 → userQuery 文本；控制字分流/无新内容返回 null
   * - userQuery 只取用户新写的正文（引用剥离后）：回复场景的主题是客户端自动加的"回复：xxx"，不是用户输入
   * - 非回复主题（用户新写）可与正文拼接；空正文+回复类主题 = 无新内容，整封跳过（纯附件信除外）
   * - #取消：中止当前编排（无执行中任务则忽略）
   */
  private normalizeMail(mail: { id: number; subject: string; body: string; attachments?: string }): string | null {
    const subject = mail.subject.trim();
    const body = stripQuote(mail.body);
    // 🔥 上传通道文件信（云端 done 合成，subject/body 以 [文件上传] 开头）：挂起不开回合——
    // 为"收到文件"跑一轮 LLM 是纯浪费，文件块由 takePendingUploads 拼进下一条真实指令
    if (subject.startsWith('[文件上传]') || body.startsWith('[文件上传]')) {
      appendPendingUpload(body);
      logger.info(`[OFFLINE-CHANNEL] 信 #${mail.id} 为 [文件上传]，挂起待下一条指令注入（挂起 ${loadPendingUploads().length} 个）`);
      return null;
    }
    const atts: Array<{ filename?: string; url?: string; size?: number }> = (() => {
      try { return mail.attachments ? JSON.parse(mail.attachments) : []; } catch { return []; }
    })();
    logger.info(`[OFFLINE-CHANNEL] 信 #${mail.id}: subject="${subject.slice(0, 40)}" 正文 ${body.length} 字符 附件 ${atts.length} 个`);

    const REPLY_SUBJECT_RE = /^(回复|答复|转发|Re|Fwd?)\s*[:：]/i;
    const isReply = REPLY_SUBJECT_RE.test(subject);
    const text = isReply ? body : [subject, body].filter(Boolean).join('\n').trim();
    if (!text && atts.length === 0) {
      logger.info(`[OFFLINE-CHANNEL] 信 #${mail.id} 无新内容（空正文+回复类主题），跳过`);
      return null;
    }
    const base = text || '';
    if (base.startsWith('#取消')) {
      if (this.executing) {
        logger.info(`[OFFLINE-CHANNEL] 信 #${mail.id} 为 #取消，中止当前编排`);
        this.cancelRequested = true;
        this.handlers?.cancel();
      } else {
        logger.info(`[OFFLINE-CHANNEL] 信 #${mail.id} 为 #取消，当前无执行中任务，忽略`);
      }
      return null;
    }
    // 🔥 云附件链接补捞：附件块在签名/引用层之后被 stripQuote 整段剥掉，URL 是执行素材必须补回
    const salvaged = salvageUrls(mail.body, base);
    return base + this.attachmentNote(atts) + (salvaged ? `\n\n[云附件链接]：\n${salvaged}\n${CLOUD_LINK_HINT}` : '');
  }

  /** 执行一个离线回合：编排 → complete（回函正文 = 回合 summarizer）；执行中并发控制轮询接 #取消 */
  private async runTask(cfg: OfflineLocalConfig, item: InboxItem): Promise<void> {
    this.executing = true;
    this.cancelRequested = false;
    notifyPhase(this.phase);
    const startedAt = Date.now();

    const watch = this.watchCancel(cfg); // 执行中轮询控制信（#取消），与主 poll 互斥运行

    // 挂起的上传文件块拼进本条指令（取走即清）：agent 带着文件继续任务，不为文件单独开回合
    const pending = takePendingUploads();
    const query = pending ? `${item.userQuery}\n\n${pending}` : item.userQuery;

    logger.info(`[OFFLINE-CHANNEL] 信 #${item.mailId} 开始执行 (${query.length} 字符${pending ? '，含挂起上传文件' : ''})`);
    try {
      let ok = true;
      let error = '';
      try {
        await this.handlers?.execute(query);
        if (this.cancelRequested) {
          ok = false;
          error = '执行中途被 #取消 命令中止';
        }
      } catch (e: any) {
        ok = false;
        error = e?.message || '执行异常';
      }

      // 等一拍让最终 summary 落进 React state（同 headless bridge）
      await this.sleep(100);
      const summary = ok ? (this.handlers?.getRoundReport() || '') : '';

      await fetch(`${CLOUD_BASE_URL}/api/offline/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.token}` },
        body: JSON.stringify({
          ok, cancelled: this.cancelRequested, summary, error, elapsedMs: Date.now() - startedAt,
          replyToMessageId: item.messageId, replyReferences: item.references, replySubject: item.subject,
        }),
      });
      if (ok) bumpTodayCount();
      logger.info(`[OFFLINE-CHANNEL] 信 #${item.mailId} 完成: ok=${ok} summary=${summary.length} 字符`);
    } finally {
      watch.stop();
      this.executing = false;
      notifyPhase(this.phase);
    }
  }

  /** 执行中控制轮询（controlOnly：云端只取走 #取消 控制信，不派普通指令），发现即中止当前编排 */
  private watchCancel(cfg: OfflineLocalConfig): { stop: () => void } {
    let watching = true;
    (async () => {
      while (watching && this.polling) {
        const fresh = loadOfflineConfig(this.userId ?? undefined);
        if (!fresh?.enabled || !fresh.token) break;
        try {
          const res = await fetch(`${CLOUD_BASE_URL}/api/offline/poll?wait=25&controlOnly=1`, {
            headers: { 'Authorization': `Bearer ${fresh.token}` },
          });
          if (!res.ok) throw new Error(`control poll ${res.status}`);
          const data = await res.json();
          if (data?.success && data.cancel) {
            logger.info('[OFFLINE-CHANNEL] 控制轮询收到 #取消，中止当前编排');
            this.cancelRequested = true;
            this.handlers?.cancel();
            break;
          }
        } catch (e: any) {
          logger.warn('[OFFLINE-CHANNEL] 控制轮询异常，5s 后重试:', e?.message);
          await this.sleep(5000);
        }
      }
    })().catch(() => { /* 控制轮询尽力而为 */ });
    return { stop: () => { watching = false; } };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export const offlineChannel = new OfflineChannel();
