/**
 * 🔥 Headless 分身 HTTP 入口（孙悟空分身：远端 Linux 无界面激活通道）
 *
 * headless 模式（TEEGAL_HEADLESS=1 或 --headless）下启动的 localhost HTTP server：
 *   POST /api/agent/query  { userQuery, callback? } → IPC 转发渲染进程执行编排（受理即回）；
 *                    callback.url 为可选 webhook——任务收尾时主动 POST 终态（短信/IM 网关等无法轮询的集成方）
 *   POST /api/agent/auth   { accessToken, refreshToken, user? } → 注入部署人凭据（谁部署用谁的身份）；
 *                    写 userData/headless-auth.json，preload 在页面脚本运行前读它恢复登录态
 *   GET  /api/agent/result?reqId=...       → 轮询任务终态（内存注册表，不查 message 表）
 *   GET  /api/agent/ping                   → 健康检查（母体确认分身在线）
 *
 * 默认只绑 127.0.0.1（母体经 SSH 进来 curl 本机端口即可，不暴露公网；
 * 如需直连可用 TEEGAL_AGENT_HOST=0.0.0.0 自行承担风险）。
 * 端口 TEEGAL_AGENT_PORT，默认 7717。
 *
 * 职责边界：只做"激活"，不做执行——执行链完整保留在渲染进程
 * （SummaryHandler 内核 → ReAct → ToolHandler → local-backend），一套代码三形态。
 */

import { ipcMain, app, type BrowserWindow } from 'electron';

const AGENT_PORT = parseInt(process.env.TEEGAL_AGENT_PORT || '7717', 10);
const AGENT_HOST = process.env.TEEGAL_AGENT_HOST || '127.0.0.1';

/** 渲染进程回包等待超时（渲染进程 10s 内不回视为未就绪/卡死） */
const RENDERER_ACK_TIMEOUT_MS = 10_000;

interface PendingAck {
  resolve: (result: { ok: boolean; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** reqId → 等待中的渲染进程回包 */
const pendingAcks = new Map<string, PendingAck>();
let _reqSeq = 0;

/**
 * 🔥 任务结果注册表（纯内存，不查任何表）：/query 受理时登记 running，
 * 渲染进程任务真正收尾时经 agent:query:final 写入终态，/api/agent/result 轮询读取。
 * message 表的异步落库与本通道完全解耦——写内存由 IPC 事件同步触发，读也是内存读，零时序问题。
 * 产物/回复按设计走项目文件与 GPU 任务回流，此处只提供确定性的完成/失败信号。
 */
interface AgentTaskRecord {
  startedAt: number;
  /** 调用方声明的完成回调地址（webhook）：与 /result 轮询正交，谁需要谁声明 */
  callback?: string;
  final?: { ok: boolean; error?: string; summary?: string; finishedAt: number };
}
const agentTasks = new Map<string, AgentTaskRecord>();
const TASK_TTL_MS = 60 * 60 * 1000; // 终态保留 1 小时，防内存无限增长

function pruneAgentTasks(): void {
  const now = Date.now();
  for (const [id, rec] of agentTasks) {
    const endAt = rec.final ? rec.final.finishedAt : rec.startedAt;
    if (now - endAt > TASK_TTL_MS) agentTasks.delete(id);
  }
}

/** 任务终态 webhook 推送：尽力而为，一次请求 15s 超时，失败仅留日志（轮询通道仍在） */
function postCallback(url: string, body: Record<string, unknown>): void {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => {
      if (!r.ok) console.error(`❌ [AGENT-SERVER] callback 非 2xx: ${r.status} → ${url}`);
      else console.log(`✅ [AGENT-SERVER] callback 已送达: ${url}`);
    }).catch((e: any) => {
      console.error(`❌ [AGENT-SERVER] callback 失败: ${url}`, e?.message);
    });
  } catch (e: any) {
    console.error(`❌ [AGENT-SERVER] callback 异常: ${url}`, e?.message);
  }
}

/**
 * 🔥 部署人凭据文件（headless 分身身份 = 谁部署用谁的身份）
 * 内置模型走云端 llm-proxy 必须带 JWT：分身服务器上无人登录，凭据只能由部署方注入。
 * preload 在页面脚本运行前 sendSync 取此文件写入 localStorage（cloud_access_token /
 * cloud_refresh_token / teegal-user），AuthContext 随后照常恢复登录态——执行链零改动。
 * accessToken 7d 过期由 refreshToken 自愈链自动续；refreshToken 30d 过期需重新注入。
 */
interface HeadlessAuthPayload {
  userId?: string;
  accessToken: string;
  refreshToken: string;
  user?: any;
  injectedAt?: string;
}

function getHeadlessAuthPath(): string {
  return require('path').join(app.getPath('userData'), 'headless-auth.json');
}

/** 读取部署人凭据（供 preload 经 ipcMain 同步通道取用） */
export function readHeadlessAuth(): HeadlessAuthPayload | null {
  try {
    const p = getHeadlessAuthPath();
    if (require('fs').existsSync(p)) return JSON.parse(require('fs').readFileSync(p, 'utf8'));
  } catch { /* 文件损坏按无凭据处理，走未登录 */ }
  return null;
}

/**
 * 🔥 启动 headless agent HTTP server（仅 headless 模式调用）
 * @param getWindow 取主窗口（渲染进程是执行宿主，窗口未就绪时拒绝请求）
 */
export function startAgentServer(getWindow: () => BrowserWindow | null): void {
  // 接收渲染进程回包（preload 的 agentQueryResult → ipcRenderer.send）
  ipcMain.on('agent:query:result', (_event, payload: { reqId: string; ok: boolean; error?: string }) => {
    const pending = payload?.reqId ? pendingAcks.get(payload.reqId) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAcks.delete(payload.reqId);
    pending.resolve({ ok: payload.ok === true, error: payload.error });
  });

  // 渲染进程任务真正收尾时写入终态（handleSendMessage resolve/reject 后经 preload agentQueryFinal 触发）
  ipcMain.on('agent:query:final', (_event, payload: { reqId: string; ok: boolean; error?: string; summary?: string }) => {
    const rec = payload?.reqId ? agentTasks.get(payload.reqId) : undefined;
    if (!rec || rec.final) return; // 未知 reqId 或已有终态：忽略（幂等）
    rec.final = { ok: payload.ok === true, error: payload.error, summary: payload.summary, finishedAt: Date.now() };
    // 调用方声明了 webhook：主动推送终态（summary 随终态一起送达）
    if (rec.callback) {
      postCallback(rec.callback, {
        reqId: payload.reqId,
        ok: rec.final.ok,
        error: rec.final.error,
        summary: rec.final.summary,
        elapsedMs: rec.final.finishedAt - rec.startedAt,
      });
    }
  });

  const server = require('http').createServer(async (req: any, res: any) => {
    const sendJson = (code: number, body: any) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    // 健康检查（母体 SSH 进来先 ping 确认分身在线）
    if (req.method === 'GET' && req.url?.startsWith('/api/agent/ping')) {
      return sendJson(200, { ok: true, headless: true, pid: process.pid, uptime: Math.round(process.uptime()) });
    }

    // 激活分身
    if (req.method === 'POST' && req.url?.startsWith('/api/agent/query')) {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 1024 * 512) req.destroy(); });
      req.on('end', async () => {
        let userQuery = '';
        let callbackUrl = '';
        try {
          const parsed = JSON.parse(body || '{}') || {};
          userQuery = String(parsed.userQuery || '').trim();
          callbackUrl = String(parsed.callback?.url || '').trim();
        } catch { /* 非法 JSON 按空处理 */ }
        if (!userQuery) {
          return sendJson(400, { ok: false, error: 'userQuery 不能为空' });
        }

        const win = getWindow();
        if (!win || win.isDestroyed()) {
          return sendJson(503, { ok: false, error: '渲染进程未就绪' });
        }

        // 转发渲染进程执行编排，等待受理回包
        const reqId = `agent-${Date.now()}-${++_reqSeq}`;
        pruneAgentTasks();
        agentTasks.set(reqId, { startedAt: Date.now(), callback: callbackUrl || undefined }); // 登记 running
        try {
          const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
            const timer = setTimeout(() => {
              pendingAcks.delete(reqId);
              resolve({ ok: false, error: '渲染进程回包超时' });
            }, RENDERER_ACK_TIMEOUT_MS);
            pendingAcks.set(reqId, { resolve, timer });
            win.webContents.send('agent:query', { reqId, userQuery });
          });
          return sendJson(result.ok ? 200 : 500, result.ok
            ? { ok: true, accepted: true, reqId, callback: !!callbackUrl, message: '任务已受理，完成后经 callback（若已声明）或 GET /api/agent/result 返回终态' }
            : { ok: false, error: result.error });
        } catch (e: any) {
          return sendJson(500, { ok: false, error: e?.message || '转发失败' });
        }
      });
      return;
    }

    // 注入部署人凭据：写文件 + 刷新页面，preload 从文件重新注入身份（部署时先收身份再收活）
    if (req.method === 'POST' && req.url?.startsWith('/api/agent/auth')) {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 1024 * 512) req.destroy(); });
      req.on('end', () => {
        let payload: any = null;
        try { payload = JSON.parse(body || '{}'); } catch { /* 非法 JSON */ }
        const accessToken = String(payload?.accessToken || '').trim();
        const refreshToken = String(payload?.refreshToken || '').trim();
        if (!accessToken || !refreshToken) {
          return sendJson(400, { ok: false, error: 'accessToken 与 refreshToken 必填' });
        }
        try {
          const record: HeadlessAuthPayload = {
            userId: String(payload?.userId || ''),
            accessToken,
            refreshToken,
            user: payload?.user || null,
            injectedAt: new Date().toISOString(),
          };
          require('fs').writeFileSync(getHeadlessAuthPath(), JSON.stringify(record, null, 2));
        } catch (e: any) {
          return sendJson(500, { ok: false, error: '凭据文件写入失败: ' + (e?.message || '') });
        }
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.reload();
        return sendJson(200, { ok: true, message: '部署人凭据已注入，页面将以此身份恢复登录态' });
      });
      return;
    }

    // 轮询任务结果：unknown→404；running→{status,elapsedMs}；done→{status,result,elapsedMs}
    if (req.method === 'GET' && req.url?.startsWith('/api/agent/result')) {
      pruneAgentTasks();
      const reqId = new URL(req.url, 'http://localhost').searchParams.get('reqId') || '';
      const rec = reqId ? agentTasks.get(reqId) : undefined;
      if (!rec) return sendJson(404, { ok: false, status: 'unknown', error: '任务不存在或已过期' });
      const elapsedMs = Date.now() - rec.startedAt;
      if (!rec.final) return sendJson(200, { ok: true, status: 'running', elapsedMs });
      return sendJson(200, { ok: true, status: 'done', result: { ok: rec.final.ok, error: rec.final.error, summary: rec.final.summary }, elapsedMs });
    }

    sendJson(404, { ok: false, error: 'not found' });
  });

  server.on('error', (e: any) => {
    console.error(`❌ [AGENT-SERVER] 启动失败:`, e?.message);
  });

  server.listen(AGENT_PORT, AGENT_HOST, () => {
    console.log(`✅ [AGENT-SERVER] Headless 分身入口已启动: http://${AGENT_HOST}:${AGENT_PORT}`);
    console.log(`   POST /api/agent/query  { "userQuery": "...", "callback": { "url": "..." }? }`);
    console.log(`   POST /api/agent/auth   { "accessToken": "...", "refreshToken": "..." }`);
    console.log(`   GET  /api/agent/result?reqId=...`);
    console.log(`   GET  /api/agent/ping`);
  });
}
