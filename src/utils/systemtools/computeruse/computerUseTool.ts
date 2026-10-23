/**
 * ComputerUse Tool：电脑操作（Windows）
 *
 * 架构（坐标 grounding 三层分离，LLM 永不接触数字坐标）：
 * - 定位层：locator.py（本目录，?raw 内嵌随包分发）截屏 + UIA/OCR/CV 三源 → 带编号候选表，
 *   坐标全部确定性产出（DPI aware 全链路物理像素，跨分辨率/缩放无需校准）
 * - 理解层：LLM 只做选择题——从候选表选编号，回传也不含坐标（坐标只留在本工具缓存里）
 * - 执行层：工具内部编号→坐标→click/type/key→光标回读验证
 *
 * 调用循环（LLM 每轮输出指令，本地回传执行结果，LLM 决定下一步）：
 * - perceive：感知屏幕 → 编号候选表（window=按窗口收窄 / filter=按文字筛选 / region=按区域感知）
 * - click/type/key：单步执行
 * - seq：多步编排一轮跑完（[{do:click,id:47},{do:type,text:x},{do:key,key:enter}]，遇错即停），
 *   序列内可插 {do:perceive} 让"点完马上看新界面"不占额外轮次
 *
 * 执行通道：复用 userpc_run_python 模式（脚本 b64 → 临时文件 → spawn python → stdout JSON）。
 * 缺 Python 依赖时自动 pip install 后重试一次（开箱即用，不烧 LLM 轮次装环境）
 */
import locatorSource from './locator.py?raw';
import { executeCommandStream } from '../executeCommand';
import type { AutoStep, AutoToolResult } from '@/utils/auto/types';

const TOOL_NAME = 'computeruse';

/** 缺失模块 → pip 包名映射（自愈安装用） */
const MODULE_PKG: Record<string, string> = {
  mss: 'mss',
  rapidocr_onnxruntime: 'rapidocr-onnxruntime',
  cv2: 'opencv-python-headless',
  uiautomation: 'uiautomation',
  PIL: 'pillow',
  numpy: 'numpy',
};

/** 最近一次感知的原始候选表（含 center，click 按 id 查坐标用）+ 感知范围（click/key
 * 执行后自动感知沿用该范围，保证后续操作与选号在同一个上下文里）。
 * 屏幕是全局单一资源，单槽缓存即可；界面变化后由下一次感知覆盖 */
let lastPerceive: {
  at: number;
  raw: any[];
  scope?: { window?: string; region?: number[] };
} | null = null;

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

/** 拼接驱动脚本：locator.py 源码 + 驱动段（参数 b64 内嵌，免一切转义）。
 * click/key 带 sense 时执行后自动附带最新感知（一次进程内完成，免二次 OCR 引擎加载）；
 * 范围内候选无变化时自动全屏重感知兜底（点击弹出的新窗口常在感知范围外） */
function buildDriverScript(params: Record<string, unknown>): string {
  const driver = `
# ==== tool driver (auto-generated) ====
import base64 as _b64
_d = json.loads(_b64.b64decode("${b64(JSON.stringify(params))}").decode("utf-8"))
_c = _d.get("cmd")

def _sense(**kw):
    return build_candidates(annotate=bool(_d.get("annotated")), icons=True,
                            max_items=int(_d.get("max_items", 120)), **kw)

def _fallback_if_unchanged(_s):
    # 范围内候选与点击/按键前完全一致 → 变化大概率在新弹窗（范围外），全屏重感知兜底
    _aft = sorted(str(c.get("text") or "") for c in _s.get("candidates", []))
    if _aft == sorted(str(t) for t in (_d.get("before_texts") or [])):
        time.sleep(0.4)
        _s = _sense()
        _s["fallback"] = "感知范围内无变化，已自动全屏重感知（点击效果可能弹出了新窗口）"
    return _s

if _c == "perceive":
    if _d.get("window"):
        # 感知窗口前自动置前：窗口被遮挡时 rect 区域截到的是遮挡者的内容，候选表会全错——
        # 先 focus（失败不阻断，可能本来就前台），保证截屏内容就是被感知窗口本身
        do_focus(_d["window"])
        time.sleep(0.3)
    _r = build_candidates(annotate=bool(_d.get("annotated")), icons=True,
                          region=_d.get("region"), text_filter=_d.get("filter"),
                          max_items=int(_d.get("max_items", 120)), window=_d.get("window"))
elif _c == "focus":
    _r = do_focus(_d["window"])
    if _r.get("focused") and _d.get("sense"):
        time.sleep(0.5)
        _r["sense"] = _sense(window=_d.get("window"))
elif _c == "click":
    _r = do_click(_d["x"], _d["y"])
    if _d.get("sense"):
        time.sleep(0.7)  # 等界面动画/弹窗稳定
        _r["sense"] = _fallback_if_unchanged(_sense(window=_d.get("sense_window"), region=_d.get("sense_region")))
elif _c == "type":
    _r = do_type(_d["text"])
elif _c == "key":
    _r = do_key(_d["key"])
    if _d.get("sense"):
        time.sleep(0.7)
        _r["sense"] = _fallback_if_unchanged(_sense(window=_d.get("sense_window"), region=_d.get("sense_region")))
else:
    _r = {"error": "unknown cmd: %s" % _c}
print("CU_JSON " + json.dumps(_r, ensure_ascii=False))
`;
  return locatorSource + '\n' + driver;
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 写临时脚本 → spawn python → 收集 stdout/stderr（复用 userpc_run_python 模式） */
function runPythonScript(script: string, timeoutSec: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const tempName = `teegal_cu_${Date.now()}.py`;
    const encoded = b64(script);
    const isWindows = navigator.platform.toLowerCase().includes('win');
    let command: string;
    if (isWindows) {
      const p = `$env:TEMP\\${tempName}`;
      command = `Remove-Item -Path "${p}" -ErrorAction SilentlyContinue; [System.IO.File]::WriteAllText("${p}", [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${encoded}"))); python "${p}"`;
    } else {
      const p = `/tmp/${tempName}`;
      command = `echo '${encoded}' | base64 -d > "${p}" && python3 "${p}"`;
    }

    const out: string[] = [];
    const err: string[] = [];
    executeCommandStream({
      command,
      timeout: timeoutSec,
      onOutput: (d) => {
        if (d.type === 'stdout' && d.data) {
          out.push(d.data);
        } else if (d.type === 'stderr' && d.data) {
          err.push(d.data);
        } else if (d.type === 'error' && d.error) {
          err.push(`[error] ${d.error}`);
        } else if (d.type === 'close') {
          resolve({ stdout: out.join('\n'), stderr: err.join('\n'), exitCode: d.exitCode ?? -1 });
        }
      },
    });
  });
}

/** 从 stdout 提取 CU_JSON 行并解析（python 环境噪音输出全部忽略） */
function parseCuJson(stdout: string): any | null {
  const idx = stdout.indexOf('CU_JSON ');
  if (idx < 0) return null;
  const lineStart = idx + 'CU_JSON '.length;
  const lineEnd = stdout.indexOf('\n', lineStart);
  const text = (lineEnd < 0 ? stdout.slice(lineStart) : stdout.slice(lineStart, lineEnd)).trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 执行 + 缺依赖自愈：ModuleNotFoundError → pip install 映射包 → 重跑一次 */
async function runWithDeps(script: string, timeoutSec: number): Promise<RunOutcome> {
  let r = await runPythonScript(script, timeoutSec);
  if (!parseCuJson(r.stdout)) {
    const missing = [...new Set([...r.stderr.matchAll(/No module named '([^']+)'/g)].map(m => m[1]))]
      .map(m => MODULE_PKG[m])
      .filter(Boolean);
    if (missing.length) {
      const installer = `import subprocess, sys\npkgs = ${JSON.stringify(missing)}\nsys.exit(subprocess.call([sys.executable, "-m", "pip", "install", "--quiet"] + pkgs))`;
      await runPythonScript(installer, 600);
      const retry = await runPythonScript(script, timeoutSec);
      retry.stderr = `[已自动安装依赖: ${missing.join(', ')}] ` + retry.stderr;
      return retry;
    }
  }
  return r;
}

function tailErr(stderr: string): string {
  const t = stderr.trim();
  return t.length > 800 ? '…' + t.slice(-800) : t;
}

/** 回传给 LLM 的候选精简（省 token）：id/source/text + 有值时 conf/type/window/dup_of。
 * 坐标（center/bbox）不回传——选号靠文字，坐标只留在本工具缓存 */
function slimCandidates(raw: any[]): any[] {
  return raw.map((c) => {
    const o: any = { id: c.id, source: c.source, text: c.text };
    if (c.conf !== undefined) o.conf = c.conf;
    if (c.type) o.type = c.type;
    if (c.window) o.window = c.window;
    if (c.dup_of) o.dup_of = c.dup_of;
    return o;
  });
}

/** 单步执行（perceive/click/type/key），seq 编排循环复用 */
async function execStep(s: Record<string, any>): Promise<AutoToolResult> {
  const act = String(s.do || s.action || '');

  // ── focus：按窗口名置前（ShowWindow 还原 + Alt 技巧 + SetForegroundWindow）→ 自动感知该窗口 ──
  if (act === 'focus') {
    const win = String(s.window || '');
    if (!win) {
      return { success: false, error: '缺少 window 参数（窗口名模糊匹配，如"微信"）', metadata: { toolName: TOOL_NAME } };
    }
    const r = await runWithDeps(buildDriverScript({ cmd: 'focus', window: win, sense: 1 }), 120);
    const data = parseCuJson(r.stdout);
    if (!data || data.error) {
      const wins = (data?.windows || []).map((w: any) => w.name).slice(0, 15).join(' | ');
      return { success: false, error: `置前失败: ${data?.error || tailErr(r.stderr)}${wins ? `。当前可见窗口: ${wins}` : ''}`, metadata: { toolName: TOOL_NAME } };
    }
    const out: any = { focused: data.focused, rect: data.rect };
    if (data.sense) {
      const sraw = data.sense.candidates || [];
      lastPerceive = { at: Date.now(), raw: sraw, scope: { window: win } };
      out.sense = {
        stats: data.sense.stats,
        screenshot: data.sense.screenshot,
        hint: 'sense 是置前后该窗口的最新感知，选号直接用它',
        candidates: slimCandidates(sraw),
      };
    }
    return { success: true, data: out, metadata: { toolName: TOOL_NAME } };
  }

  // ── perceive：感知屏幕 → 编号候选表 ──
  if (act === 'perceive') {
    const params: Record<string, unknown> = { cmd: 'perceive' };
    if (s.filter) params.filter = String(s.filter);
    if (s.window) params.window = String(s.window);
    if (s.region) params.region = s.region; // [x,y,w,h] 物理像素
    if (s.maxItems) params.max_items = Number(s.maxItems);
    if (s.annotated) params.annotated = true;

    const r = await runWithDeps(buildDriverScript(params), Number(s.timeout) || 240);
    const data = parseCuJson(r.stdout);
    if (!data) {
      return { success: false, error: `感知失败: ${tailErr(r.stderr) || `退出码 ${r.exitCode}`}`, metadata: { toolName: TOOL_NAME } };
    }
    // 窗口匹配失败：回传可见窗口列表，LLM 据此纠正 window 参数
    if (data.error) {
      const wins = (data.windows || []).map((w: any) => w.name).slice(0, 15).join(' | ');
      return {
        success: false,
        error: `感知失败: ${data.error}${wins ? `。当前可见窗口: ${wins}（可用 window 参数按窗口名重试）` : ''}`,
        metadata: { toolName: TOOL_NAME },
      };
    }
    const raw = data.candidates || [];
    lastPerceive = {
      at: Date.now(),
      raw,
      scope: { window: s.window ? String(s.window) : undefined, region: s.region },
    };
    return {
      success: true,
      data: {
        stats: data.stats,
        totalBeforeTrim: data.total_before_trim,
        elapsed: data.elapsed,
        screenshot: data.screenshot,
        annotated: data.annotated,
        hint: '从 candidates 选 id 传给 click。无文字图标（[图标]条目）无法靠文字选号: 传 annotated:true 重新感知拿标注图路径 → web_url_reader 传该路径让视觉模型指认"目标按钮是哪个编号" → click 该编号。严禁用 pyautogui/userpc_run_python 模拟坐标点击（截图尺寸≠屏幕像素，缩放换算必错）',
        candidates: slimCandidates(raw),
      },
      metadata: { toolName: TOOL_NAME },
    };
  }

  // ── click：编号 → 坐标（查缓存）→ 点击 → 回读 → 自动感知（省一轮 perceive）──
  if (act === 'click') {
    const id = Number(s.id);
    if (!id) {
      return { success: false, error: '缺少 id 参数（必须来自最近一次感知的候选编号）', metadata: { toolName: TOOL_NAME } };
    }
    const hit = lastPerceive?.raw.find(c => c.id === id);
    if (!hit) {
      return {
        success: false,
        error: `编号 #${id} 不在最近一次感知结果中（共 ${lastPerceive?.raw.length ?? 0} 条）。界面可能已变化，请先 perceive 重新感知`,
        metadata: { toolName: TOOL_NAME },
      };
    }
    // 防呆闸：expect 与候选文字不符则拒点（防 LLM 幻觉编号——尤其 fallback 全屏感知后编号已重排）
    if (s.expect) {
      const norm = (v: string) => (v || '').replace(/[\s_]/g, '');
      const expectN = norm(String(s.expect));
      const hitN = norm(hit.text || '');
      if (hitN && expectN && !hitN.includes(expectN)) {
        return {
          success: false,
          error: `已拒绝点击：编号 #${id} 对应 "${hit.text}"，与预期 "${s.expect}" 不符。编号引用错了——请重新 perceive 并从最新候选表核对文字与 id 的对应关系`,
          metadata: { toolName: TOOL_NAME },
        };
      }
    }
    const driverParams: Record<string, unknown> = { cmd: 'click', x: hit.center[0], y: hit.center[1] };
    if (s.sense !== 0 && s.sense !== false) {
      // 自动感知沿用上次感知范围（窗口级秒级返回）；带点击前候选文字集，范围内无变化时 driver 自动全屏兜底
      driverParams.sense = 1;
      if (lastPerceive?.scope?.window) driverParams.sense_window = lastPerceive.scope.window;
      if (lastPerceive?.scope?.region) driverParams.sense_region = lastPerceive.scope.region;
      driverParams.before_texts = (lastPerceive?.raw || []).map(c => c.text);
    }
    const r = await runWithDeps(buildDriverScript(driverParams), 240);
    const data = parseCuJson(r.stdout);
    if (!data || data.error) {
      return { success: false, error: `点击失败: ${data?.error || tailErr(r.stderr)}`, metadata: { toolName: TOOL_NAME } };
    }
    const out: any = {
      clicked: { id: hit.id, text: hit.text, source: hit.source },
      cursor: data.cursor,
    };
    // 点击后的最新感知：刷缓存 + 回传，LLM 下一轮直接选新编号（省一轮 perceive）
    if (data.sense) {
      const sraw = data.sense.candidates || [];
      lastPerceive = { at: Date.now(), raw: sraw, scope: lastPerceive?.scope };
      out.sense = {
        stats: data.sense.stats,
        screenshot: data.sense.screenshot,
        annotated: data.sense.annotated,
        fallback: data.sense.fallback,
        hint: 'sense 是点击后的最新屏幕感知，选号直接用它，无需再 perceive；核验点击效果只看 sense，勿用 web_url_reader 看截图核验（视觉仅用于图标编号指认）' +
          (data.sense.fallback ? '。⚠️ 本表为全屏感知，编号已全部重排，下次 click 必须传 expect 参数核对目标文字' : ''),
        candidates: slimCandidates(sraw),
      };
    }
    return { success: true, data: out, metadata: { toolName: TOOL_NAME } };
  }

  // ── type：剪贴板 + Ctrl+V（支持中文，焦点由前置 click 保证）──
  if (act === 'type') {
    const text = s.text;
    if (!text || typeof text !== 'string') {
      return { success: false, error: '缺少 text 参数', metadata: { toolName: TOOL_NAME } };
    }
    const r = await runWithDeps(buildDriverScript({ cmd: 'type', text }), 60);
    const data = parseCuJson(r.stdout);
    if (!data || data.error) {
      return { success: false, error: `输入失败: ${data?.error || tailErr(r.stderr)}`, metadata: { toolName: TOOL_NAME } };
    }
    return { success: true, data, metadata: { toolName: TOOL_NAME } };
  }

  // ── key：单键/组合键 → 自动感知（enter/esc 后界面常变：发送消息、关面板）──
  if (act === 'key') {
    const key = String(s.key || '');
    if (!key) {
      return { success: false, error: '缺少 key 参数（如 enter / esc / ctrl+s）', metadata: { toolName: TOOL_NAME } };
    }
    const driverParams: Record<string, unknown> = { cmd: 'key', key };
    if (s.sense !== 0 && s.sense !== false) {
      driverParams.sense = 1;
      if (lastPerceive?.scope?.window) driverParams.sense_window = lastPerceive.scope.window;
      if (lastPerceive?.scope?.region) driverParams.sense_region = lastPerceive.scope.region;
      driverParams.before_texts = (lastPerceive?.raw || []).map(c => c.text);
    }
    const r = await runWithDeps(buildDriverScript(driverParams), 240);
    const data = parseCuJson(r.stdout);
    if (!data || data.error) {
      return { success: false, error: `按键失败: ${data?.error || tailErr(r.stderr)}`, metadata: { toolName: TOOL_NAME } };
    }
    const out: any = data;
    if (data.sense) {
      const sraw = data.sense.candidates || [];
      lastPerceive = { at: Date.now(), raw: sraw, scope: lastPerceive?.scope };
      out.sense = {
        stats: data.sense.stats,
        screenshot: data.sense.screenshot,
        annotated: data.sense.annotated,
        fallback: data.sense.fallback,
        hint: 'sense 是按键后的最新屏幕感知，选号直接用它，无需再 perceive；核验按键效果只看 sense，勿用 web_url_reader 看截图核验（视觉仅用于图标编号指认）',
        candidates: slimCandidates(sraw),
      };
    }
    return { success: true, data: out, metadata: { toolName: TOOL_NAME } };
  }

  return {
    success: false,
    error: `未知动作: ${act}。可用: focus / perceive / click / type / key`,
    metadata: { toolName: TOOL_NAME },
  };
}

export async function executeComputerUseTool(
  step: AutoStep,
  _sessionId: string,
  onProgress?: (progress: { type: string; data?: string }) => void,
  _context?: { userId?: string }
): Promise<AutoToolResult> {
  if (!navigator.platform.toLowerCase().includes('win')) {
    return { success: false, error: 'computeruse 工具暂仅支持 Windows', metadata: { toolName: TOOL_NAME } };
  }

  const p = step.toolParams || {};
  const action = String(p.action || '');

  // ── seq：多步编排一轮跑完（type+enter / click+type+key 等），遇错即停回传汇总。
  // 中间步骤不感知（缓存不动，id 全程引用 seq 开始时的候选表）；结尾统一感知一次，
  // LLM 无需为"确认结果"多烧一轮 ──
  if (action === 'seq') {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    if (!steps.length) {
      return { success: false, error: '缺少 steps 参数（如 [{do:"type",text:"你好"},{do:"key",key:"enter"}]）', metadata: { toolName: TOOL_NAME } };
    }
    const results: any[] = [];
    for (let i = 0; i < steps.length; i++) {
      const r = await execStep({ ...(steps[i] || {}), sense: 0 });
      results.push({ step: i + 1, ...r.data, success: r.success, error: r.error });
      if (!r.success) {
        onProgress?.({ type: 'complete', data: `seq 第 ${i + 1} 步失败，已停止后续步骤` });
        break;
      }
    }
    // 结尾感知（沿用 seq 开始时的感知范围），作为最后一条结果回传
    const fin = await execStep({ do: 'perceive', ...(lastPerceive?.scope || {}) });
    results.push({
      step: results.length + 1, do: 'perceive', success: fin.success,
      error: fin.error, ...(fin.data ? { sense: fin.data.candidates, screenshot: fin.data.screenshot } : {}),
    });
    const stepsOk = results.slice(0, -1).every(r => r.success);
    onProgress?.({ type: 'complete', data: `seq 完成 ${results.length - 1}/${steps.length} 步 + 结尾感知` });
    return {
      success: stepsOk && fin.success,
      data: { executed: results.length - 1, total: steps.length, steps: results },
      error: stepsOk ? undefined : `seq 第 ${results.length - 1} 步失败: ${results[results.length - 2]?.error || '未知'}`,
      metadata: { toolName: TOOL_NAME },
    };
  }

  return execStep(p);
}
