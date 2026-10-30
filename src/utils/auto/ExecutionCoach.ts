/**
 * 🔥 执行过程辅导（Execution Coach）
 *
 * 泛化自 ReActExecutor 的「只读打转预警」：一组「tool 排列/统计特征 → 注入文本」规则。
 * 每轮工具执行完毕后用累计 toolResults 匹配特征，命中文本经 systemReminder 独立通道
 * 渲染在下一轮 prompt 尾部（不进环境注入段，不破缓存前缀）。
 *
 * 新增辅导场景 = 在 COACH_RULES 里加一条规则（detect 返回注入文本，空串 = 本轮不注入）。
 */

/** 最小结构化入参（ReActExecutor 的 ToolResult 结构兼容即可，避免反向依赖其私有类型） */
export interface CoachToolResult {
  toolName: string;
  /** 工具成败（ReActExecutor.ToolResult 顶层无此字段，实际值在 result.success，见 toolSuccess） */
  success?: boolean;
  /** 兼容 ReActExecutor.ToolResult 的嵌套结果（result.success 才是真实成败） */
  result?: { success?: boolean };
}

/** 取工具成败：顶层 success 优先，兼容嵌套 result.success */
function toolSuccess(r?: CoachToolResult): boolean | undefined {
  return r?.success ?? r?.result?.success;
}

interface CoachRule {
  /** 规则名（日志用） */
  name: string;
  /** 特征匹配：返回注入文本，空串 = 本轮不注入；sessionKey 供状态型规则做会话级去重 */
  detect(toolResults: CoachToolResult[], sessionKey?: string): string;
}

// ============================================================================
// 规则 1：只读侦察打转预警
// ============================================================================

/**
 * 连续多轮 read/list 只读不写是"读了又读不落笔"的拖延信号
 * （mvrls5kd 轨迹实证：30+ 轮反复读类型/签名，三轮自称"最后一次读取"，宣布"下一轮一次性写"
 * 却从不兑现）。不拦截调用（大文件分段读是正当场景），只在阈值点注入点名提醒逼当场落笔；
 * 逃生门指向笔记机制（笔记跨归档周期存留，是关键契约的正确存放处，该轨迹里 LLM 一条笔记没写）。
 */
const READONLY_RECON_TOOLS = new Set(['read_project_file', 'list_project_files']);

/** 连续只读轮数：从最新条目向前数，遇到任何非只读工具即停（写/执行/complete 都算破环） */
function readReconStreak(toolResults: CoachToolResult[]): number {
  let n = 0;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    if (READONLY_RECON_TOOLS.has(toolResults[i]?.toolName || '')) n++;
    else break;
  }
  return n;
}

const readLoopRule: CoachRule = {
  name: '只读打转预警',
  detect(toolResults) {
    const streak = readReconStreak(toolResults);
    if (streak < 4 || (streak - 4) % 4 !== 0) return ''; // 连续只读 ≥4 轮时注入（4/8/12…每 +4 再提一次）
    console.log(`🔄 [EXEC-COACH] 只读打转预警注入: 连续 ${streak} 轮只读未写`);
    return `⚠️ 打转预警（系统检测）：已连续 ${streak} 轮只读文件、未做任何写入。这是"先再核对一下"式拖延的信号——立即当轮落笔开始写代码；若确有怕丢的关键字段/签名，本轮先用一次 save_project_file 写成笔记（笔记跨归档周期存留），之后凭笔记写，禁止再读原文件。`;
  },
};

// ============================================================================
// 规则 2：未验证的批量写入（契约对齐提醒）
// ============================================================================

/**
 * 一次并行/连续写多个互相依赖的文件，模块间 import/export 契约极易错位
 * （mvuqxj7k 轨迹实证：一轮并行写 5 个文件，首次构建爆出十几个接口不一致错误——导出名拼错、
 * 缺方法、类型不匹配；错误清单已全列出却不先修，20 分钟烧在换构建工具上）。
 *
 * 统计口径 = 从最新条目向前数「距上次执行验证」的连续写入长度：
 * - 中性工具（read/list/搜索等）不破块——写完读两个文件再写是常见节奏，提醒不该消失；
 * - 验证类工具（跑码/shell/python/实例执行/看日志）消费写块——跑过一次即视为已对齐，停。
 */
const BATCH_WRITE_TOOLS = new Set(['save_project_file', 'edit_project_file']);
const VERIFY_TOOLS = new Set([
  'run_project_onlocal', 'run_project_oncloud', 'userpc_shell', 'userpc_run_python',
  'ssh_remote', 'get_task_detail', 'list_tasks',
]);
const BATCH_WRITE_THRESHOLD = 3;

function unverifiedBatchWriteStreak(toolResults: CoachToolResult[]): number {
  let n = 0;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const name = toolResults[i]?.toolName || '';
    if (BATCH_WRITE_TOOLS.has(name)) { n++; continue; }
    if (VERIFY_TOOLS.has(name)) break;
    // 其余（read/list/web/memory/complete 等）视为中性：跳过继续向前
  }
  return n;
}

const batchWriteRule: CoachRule = {
  name: '契约对齐提醒',
  detect(toolResults) {
    const streak = unverifiedBatchWriteStreak(toolResults);
    if (streak < BATCH_WRITE_THRESHOLD) return '';
    console.log(`📐 [EXEC-COACH] 契约对齐提醒注入: 距上次执行验证连续写入 ${streak} 个文件`);
    return `⚠️ 契约对齐提醒（系统检测）：距上次执行验证，已连续写入 ${streak} 个项目文件。批量写互相依赖的文件时，模块间 import/export 契约极易错位（导出名拼错、引用不存在的方法、类型不一致），且错误会相互掩盖。下一步先做一次对齐验证——TS 项目 npx tsc --noEmit，Python 项目 python -m compileall 或实际执行一次入口——拿到报错清单后一次全修完再继续写新文件；不要边攒错误边换构建工具。`;
  },
};

// ============================================================================
// 规则 3：项目拉起失败 → 日志通道指引（事件型，天然一次性）
// ============================================================================

/**
 * run_project_onlocal 失败后，LLM 的默认动作是去项目目录翻日志文件——但目录里的
 * srv_err.log 等是历史执行的残留，本次 stderr 根本不在那（mvutnii1 轨迹实证：烧掉
 * 十几轮 shell 才定位根因）。失败回执已带 stderr 尾部 + 日志指针，此规则补一刀指路。
 * 触发窗口 = 失败的 run_project_onlocal 是最新一条：LLM 下一轮做任何事即自动解除，
 * 天然一次性，无需去重状态。
 */
const localRunFailRule: CoachRule = {
  name: '拉起失败日志指引',
  detect(toolResults) {
    const latest = toolResults[toolResults.length - 1];
    if (latest?.toolName !== 'run_project_onlocal' || toolSuccess(latest) !== false) return '';
    console.log('🧭 [EXEC-COACH] 拉起失败日志指引注入: 最新一条 run_project_onlocal 失败');
    return `⚠️ 排查指引（系统检测）：run_project_onlocal 刚执行失败——回执已附带 stderr 尾部，优先按其中根因修代码；需要完整日志时用 get_task_detail(taskId='回执中的日志ID') 查平台日志池，不要去项目目录翻历史日志文件（多为旧执行残留，本次的 stderr 不在那里）。修复源码后若项目以构建产物（dist/build）启动，需重新构建再验证——改源码不重建等于白改。`;
  },
};

// ============================================================================
// 规则 4：改过源码且执行过项目 → 产物对齐提醒（状态型，每会话 1 次）
// ============================================================================

/**
 * 「源码修了 ≠ 修好」（mvutnii1 轨迹实证：上一会话改源码验证全绿收工，dist 产物从未
 * 重建，用户下次正常拉起（走产物入口）直接 exit 1；且手补产物只救急、会被下次构建覆盖，
 * 产物里其余未同步的修复（异常兜底）仍缺失）。条件 = 会话内最后一次写文件之后执行过
 * 项目——此时该提醒收尾验证口径。每会话最多注入 1 次（SESSION_REMINDED 记账）。
 */
const RUN_PROJECT_TOOLS = new Set(['run_project_onlocal', 'run_project_oncloud', 'userpc_shell']);

/** 会话级已提醒记账（key = sessionId|规则名；设上限防跨会话泄漏） */
const SESSION_REMINDED = new Set<string>();

const buildOutputRule: CoachRule = {
  name: '产物对齐提醒',
  detect(toolResults, sessionKey) {
    if (!sessionKey) return '';
    if (SESSION_REMINDED.size > 500) SESSION_REMINDED.clear();
    const dedupKey = `${sessionKey}|buildOutput`;
    if (SESSION_REMINDED.has(dedupKey)) return '';

    // 会话内最后一次写文件的位置
    let lastWriteIdx = -1;
    for (let i = toolResults.length - 1; i >= 0; i--) {
      if (BATCH_WRITE_TOOLS.has(toolResults[i]?.toolName || '')) { lastWriteIdx = i; break; }
    }
    if (lastWriteIdx < 0) return '';
    // 其后执行过项目（拉起/跑码/shell），才谈得上「产物是否对齐」
    const ranProjectAfterWrite = toolResults
      .slice(lastWriteIdx + 1)
      .some(r => RUN_PROJECT_TOOLS.has(r?.toolName || ''));
    if (!ranProjectAfterWrite) return '';

    SESSION_REMINDED.add(dedupKey);
    console.log('📐 [EXEC-COACH] 产物对齐提醒注入: 会话内改过源码且执行过项目');
    return `⚠️ 产物对齐提醒（系统检测，本会话仅此一次）：本会话修改过项目源码，且之后执行过项目。若该项目以构建产物（dist/build）方式启动，源码修改不会生效——收尾前先重新构建（npm run build 或项目对应 build 脚本），并在产物入口上验证通过才算修好；直接手改产物只能救急，下次构建会被覆盖。`;
  },
};

// ============================================================================
// 规则汇总与出口
// ============================================================================

const COACH_RULES: CoachRule[] = [readLoopRule, batchWriteRule, localRunFailRule, buildOutputRule];

/**
 * 🔥 每轮工具执行后调用：遍历规则，拼接命中的提醒文本（空串 = 本轮无提醒）
 * @param sessionKey 会话标识（状态型规则的每会话去重键；ReActExecutor 传 sessionId）
 */
export function buildSystemReminder(toolResults: CoachToolResult[], sessionKey?: string): string {
  return COACH_RULES
    .map(rule => rule.detect(toolResults, sessionKey))
    .filter(Boolean)
    .join('\n\n');
}
