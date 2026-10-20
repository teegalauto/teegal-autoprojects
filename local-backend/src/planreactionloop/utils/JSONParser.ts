/**
 * JSON 解析工具
 * 多层容错解析，处理 LLM 返回的非标准 JSON
 */

/**
 * 🔥 常见 LaTeX 命令字典（仅收录首字母为 t/n/r/b/f/u 的命令）
 *
 * 背景：JSON 合法转义符恰好是 \t \n \r \b \f \u \" \\ \/
 * 当 LLM 在 JSON 字符串里写单反斜杠 LaTeX（如 $\theta$）时，
 * \theta 会被 JSON.parse 静默解析成 TAB + "heta"，\nu 变成换行 + "u"，
 * \rho 变成回车 + "ho"，\frac 变成换页 + "rac" —— 公式被无声破坏。
 * 其他首字母的命令（\sum \ge \gamma 等）不是合法转义，走通用修复即可，无需字典。
 */
const LATEX_TNRBFU_COMMANDS = /\\(?:t(?:h(?:ickapprox|erefore|eta)?|ilde|imes|o|an(?:h)?|op|riangle|frac|ext(?:rm|bf|it|tt)?)|n(?:abla|ewline|eq|ot|eg|mid|u)|r(?:ight(?:arrow|leftharpoons)?|floor|ceil|angle|brack|brace|vert|ho)|b(?:oldsymbol|ullet|owtie|eta|ar|ig(?:g|l|r)?|ot|mod)|f(?:rown|orall|rac)|u(?:nder(?:brace|line)|psilon))(?![a-zA-Z])/g;

/**
 * 🔥 修复 JSON 源文本中的无效转义（LaTeX 反斜杠场景）
 * 统一供 safeJSONParse 第2/4层复用
 */
export function repairJSONEscapes(jsonStr: string): string {
  let fixed = jsonStr;
  // 1. 先把合法的双反斜杠（\\）替换为占位符，保护它们不被误改
  const PLACEHOLDER = '\u0000';
  fixed = fixed.replace(/\\\\/g, PLACEHOLDER);
  // 2. 🔥 保护 LaTeX 命令占位（\theta/\times/\neq 等首字母恰为 JSON 合法转义符的命令）
  const latexPlaceholders: string[] = [];
  fixed = fixed.replace(LATEX_TNRBFU_COMMANDS, (m) => {
    latexPlaceholders.push(m);
    return `\u0001${latexPlaceholders.length - 1}\u0001`;
  });
  // 3. 修复无效转义：\x -> \\x（x 不是合法 JSON 转义字符，如 \sum 的 \s）
  fixed = fixed.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
  // 4. 还原双反斜杠占位符
  fixed = fixed.replace(/\u0000/g, '\\\\');
  // 5. 🔥 还原 LaTeX 命令（补一个反斜杠：raw \theta → \\theta，解析后值中才是 \theta 原样）
  fixed = fixed.replace(/\u0001(\d+)\u0001/g, (_, i) => '\\' + latexPlaceholders[parseInt(i)]);
  return fixed;
}

/**
 * 🔥 检测"合法转义"造成的静默破坏
 *
 * 背景：\theta 的 \t 恰好是合法 JSON 转义符，JSON.parse 会"成功"但把 \theta
 * 静默解析成 TAB+"heta"（\nu → 换行+"u"、\rho → 回车+"ho" 同理）。
 * 这种破坏不抛错，直接走第1层返回脏数据，必须解析后检测。
 *
 * 模式：控制字符（\t \n \r \b \f）后紧跟对应命令的剩余字母，且后面不是字母。
 * （\u 开头的命令不会静默破坏：\u 后非4位十六进制会让 JSON.parse 直接抛错，自然走修复层）
 */
const SILENT_LATEX_CORRUPTION = /(?:[\t](?:h(?:ickapprox|erefore|eta)?|ilde|imes|o|an(?:h)?|op|riangle|frac|ext(?:rm|bf|it|tt)?)|[\n](?:abla|ewline|eq|ot|eg|mid|u)|[\r](?:ight(?:arrow|leftharpoons)?|floor|ceil|angle|brack|brace|vert|ho)|[\b](?:oldsymbol|ullet|owtie|eta|ar|ig(?:g|l|r)?|ot|mod)|[\f](?:rown|orall|rac))(?![a-zA-Z])/;

/** 递归检查解析结果中是否有被静默破坏的 LaTeX 命令 */
function hasSilentLatexCorruption(value: unknown): boolean {
  if (typeof value === 'string') return SILENT_LATEX_CORRUPTION.test(value);
  if (Array.isArray(value)) return value.some(hasSilentLatexCorruption);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasSilentLatexCorruption);
  }
  return false;
}

/**
 * 🔥 反转义 JSON 字符串字面量内容（不含首尾引号）
 * 用于 SummaryModule fallback 等从原始文本正则提取字段后的还原
 */
export function unescapeJSONString(raw: string): string {
  // 优先走标准解析（内含 LaTeX 命令保护）
  const parsed = safeJSONParse(`"${raw}"`);
  if (typeof parsed === 'string') return parsed;

  // 兜底：手动反转义（带 LaTeX 命令保护，避免 \nu → 换行+u、\theta → TAB+heta）
  let s = raw;
  const latexPh: string[] = [];
  s = s.replace(LATEX_TNRBFU_COMMANDS, (m) => {
    latexPh.push(m);
    return `\u0001${latexPh.length - 1}\u0001`;
  });
  s = s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b').replace(/\\f/g, '\f')
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => latexPh[parseInt(i)]);
  return s;
}

/**
 * 尝试修复常见的 JSON 格式问题
 */
export function fixMalformedJSON(jsonStr: string): string {
  try {
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    // 继续尝试修复
  }

  let result = jsonStr;

  // 修复1：处理多行字符串值（将换行符转为 \n）
  const stringValuePattern = /"([^"]+)"\s*:\s*"([\s\S]*?)"(?=\s*[,}])/g;
  let match;
  const replacements: Array<{ start: number; end: number; fixed: string }> = [];

  while ((match = stringValuePattern.exec(jsonStr)) !== null) {
    const fullMatch = match[0];
    const key = match[1];
    let value = match[2];
    const matchStart = match.index;
    const matchEnd = matchStart + fullMatch.length;

    let needsFix = false;

    if (value.includes('\n') || value.includes('\r')) {
      needsFix = true;
    }

    for (let i = 0; i < value.length; i++) {
      if (value[i] === '"') {
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) {
          backslashCount++;
        }
        if (backslashCount % 2 === 0) {
          needsFix = true;
          break;
        }
      }
    }

    if (needsFix) {
      let fixedValue = '';
      for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '\n') {
          fixedValue += '\\n';
        } else if (char === '\r') {
          fixedValue += '\\r';
        } else if (char === '\t') {
          fixedValue += '\\t';
        } else if (char === '"') {
          let backslashCount = 0;
          for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) {
            backslashCount++;
          }
          if (backslashCount % 2 === 0) {
            fixedValue += '\\"';
          } else {
            fixedValue += char;
          }
        } else if (char === '\\') {
          const nextChar = value[i + 1];
          if (nextChar && ['n', 'r', 't', '"', '\\', 'b', 'f', 'u'].includes(nextChar)) {
            fixedValue += char;
          } else {
            fixedValue += '\\\\';
          }
        } else {
          fixedValue += char;
        }
      }
      const fixed = `"${key}": "${fixedValue}"`;
      replacements.push({ start: matchStart, end: matchEnd, fixed });
    }
  }

  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, fixed } = replacements[i];
    result = result.substring(0, start) + fixed + result.substring(end);
  }

  // 修复2：括号不匹配（字符串感知 + 就地补齐闭合符）
  // 旧实现只把缺失闭合符追加到末尾：能救"输出被截断"，救不了"中间漏一个 }"——
  // 真实案例：GLM 输出深嵌套+长字符串 JSON 时漏掉工具对象的闭合 }，后面还有
  // 数组的 ] 和根 }，旧逻辑跳过不匹配的 ]、误消费根 }，补完仍非法 → sessioncreate 掉会话。
  // 就地补齐：遇到 ]/} 与栈顶不符时，先把内层缺失的闭合符补在当前位置再消费当前字符；
  // 末尾再按嵌套逆序补齐截断场景的剩余开括号。顺带清理 ] } 前的悬挂逗号。
  const bracketStack: string[] = [];
  let inString = false;
  let escaped = false;
  let balanced = '';
  for (let i = 0; i < result.length; i++) {
    const char = result[i];
    if (escaped) { escaped = false; balanced += char; continue; }
    if (char === '\\') { escaped = true; balanced += char; continue; }
    if (char === '"') { inString = !inString; balanced += char; continue; }
    if (inString) { balanced += char; continue; }
    if (char === '{' || char === '[') {
      bracketStack.push(char);
      balanced += char;
    } else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      let drop = false;
      if (bracketStack.length && bracketStack[bracketStack.length - 1] === expected) {
        bracketStack.pop();
      } else if (bracketStack.includes(expected)) {
        // 内层漏闭合：就地补齐（内层先关），如 [... { ... ] → [... { ... }]
        while (bracketStack.length && bracketStack[bracketStack.length - 1] !== expected) {
          const open = bracketStack.pop()!;
          balanced += open === '{' ? '}' : ']';
        }
        bracketStack.pop();
      } else {
        drop = true; // 多余的闭合符（栈中无对应开括号）：丢弃
      }
      if (!drop) {
        balanced += char;
      }
    } else {
      balanced += char;
    }
  }
  // 截断场景：仍未闭合的开括号按嵌套逆序补到末尾
  for (let i = bracketStack.length - 1; i >= 0; i--) {
    balanced += bracketStack[i] === '{' ? '}' : ']';
  }
  // 🔥 悬挂逗号统一清理（字符串感知）：扫描内就地补齐的闭合符和末尾补齐的闭合符
  // 都可能前面残留逗号（如 {...true}, + 补]} → ,]} 非法），末尾一次清干净
  result = stripDanglingCommas(balanced);

  return result;
}

/** 字符串感知的悬挂逗号清理：仅删除 } ] 前的逗号（字符串内容不碰） */
function stripDanglingCommas(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '}' || ch === ']') {
      const trimmed = out.replace(/\s+$/, '');
      if (trimmed.endsWith(',')) out = trimmed.slice(0, -1);
    }
    out += ch;
  }
  return out;
}

/**
 * 解析 + LaTeX 静默破坏检测
 * \theta 等首字母恰为合法转义的命令会被 JSON.parse"成功"但静默破坏（\t→TAB），
 * 解析成功也必须检测，破坏时带 LaTeX 保护重修；重修失败宁可返回脏数据不丢内容
 */
function checkedParse(s: string): any {
  const result = JSON.parse(s);
  if (!hasSilentLatexCorruption(result)) return result;
  try {
    return JSON.parse(repairJSONEscapes(s));
  } catch {
    return result;
  }
}

/**
 * 组合修复管线：依次尝试 原样 → 修转义 → 修结构 → 归一化 → 归一化+修结构
 * 供 safeJSONParse 高层（提取主体后/归一化后）复用
 */
function parseWithAllFixes(s: string): any | null {
  const candidates = [
    s,
    repairJSONEscapes(s),
    fixMalformedJSON(s),
    normalizeJSONStructure(s),
    fixMalformedJSON(normalizeJSONStructure(s)),
  ];
  for (const candidate of candidates) {
    try {
      return checkedParse(candidate);
    } catch {
      // 下一个候选
    }
  }
  return null;
}

/**
 * 安全的 JSON 解析
 * 多层尝试：直接解析 → 修复转义 → 修复结构 → 提取主体+全管线 → 全角/Python字面量归一化
 */
export function safeJSONParse(jsonStr: string): any | null {
  // 第0层：去 BOM（JSON.parse 对 \uFEFF 直接抛错）
  if (jsonStr.charCodeAt(0) === 0xfeff) {
    jsonStr = jsonStr.slice(1);
  }

  // 第1层：直接解析（含 LaTeX 静默破坏检测）
  try {
    return checkedParse(jsonStr);
  } catch {
    // 继续尝试
  }

  // 第2层：修复无效的转义序列（如 \a, \[, \] 等 LaTeX 公式中的反斜杠）
  // 🔥 含 LaTeX 命令保护（\theta/\times/\neq 等首字母恰为 JSON 合法转义符的命令）
  try {
    return checkedParse(repairJSONEscapes(jsonStr));
  } catch {
    // 继续尝试
  }

  // 第3层：使用 fixMalformedJSON 修复（多行字符串 + 括号就地补齐）
  try {
    const fixed = fixMalformedJSON(jsonStr);
    if (fixed !== jsonStr) {
      return checkedParse(fixed);
    }
  } catch {
    // 继续尝试
  }

  // 第4层：提取 JSON 主体（剥 markdown 围栏/前后散文）后跑完整修复管线
  // 🔥 旧实现提取后只修转义——"围栏+漏括号/截断"组合场景救不了
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const inner = jsonStr.substring(firstBrace, lastBrace + 1);
      const result = parseWithAllFixes(inner);
      if (result !== null) return result;
    } catch {
      // 继续尝试
    }
  }

  // 第5层：全角结构符/Python 字面量归一化（中文弱模型常见瑕疵，仅动字符串外的结构符）
  try {
    const normalized = normalizeJSONStructure(jsonStr);
    if (normalized !== jsonStr) {
      const result = parseWithAllFixes(normalized);
      if (result !== null) return result;
    }
  } catch {
    // 继续尝试
  }

  return null;
}

/**
 * 🔥 结构归一化（最后一道抢救层，仅动字符串"外"的结构性瑕疵，字符串内容一律不碰）：
 * - 全角结构符 → ASCII：：，｛｝［］“”（中文弱模型在结构位打全角是常见瑕疵）
 * - Python 字面量 → JSON：True/False/None → true/false/null（词边界，仅字符串外）
 * 注意：全角引号当定界符的退化场景中，其"字符串内容"也会过 Python 字面量替换——
 * 该层仅在常规解析全部失败后触发，宁可小概率内容变形也不放弃整个 JSON。
 * ASCII 单引号定界（'a':1）不做处理：与英文撇号无法区分，误伤风险大于收益。
 */
export function normalizeJSONStructure(jsonStr: string): string {
  const FW: Record<string, string> = {
    '：': ':', '，': ',', '｛': '{', '｝': '}', '［': '[', '］': ']', '“': '"', '”': '"',
  };
  let out = '';
  let inString = false;
  let escaped = false;
  let plain = ''; // 当前连续非字符串片段
  const flush = () => {
    if (!plain) return;
    let t = '';
    for (const ch of plain) t += FW[ch] ?? ch;
    t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    out += t;
    plain = '';
  };
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { flush(); inString = true; out += ch; continue; }
    plain += ch;
  }
  flush();
  return out;
}

/**
 * 🔥 字符串感知的平衡闭合定位：返回 text[openIdx]（[ 或 {）的匹配闭合符下标。
 * 括号交叉错乱（漏括号导致栈不匹配）返回 -1，调用方回退为"截到末尾"交给修复管线。
 */
export function findBalancedEnd(text: string, openIdx: number): number {
  const open = text[openIdx];
  if (open !== '[' && open !== '{') return -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[' || ch === '{') { stack.push(ch); continue; }
    if (ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top) return -1;
      if ((ch === ']' && top !== '[') || (ch === '}' && top !== '{')) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/**
 * 🔥 平衡括号提取顶层 JSON 对象（字符串感知，嵌套 parameters 不再被 [^}]* 截断）。
 * 每个候选走 safeJSONParse 全修复管线（含未闭合尾部对象的补齐抢救），坏对象丢弃。
 */
export function extractJSONObjects(text: string): any[] {
  const results: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const obj = safeJSONParse(text.slice(start, i + 1));
        if (obj && typeof obj === 'object') results.push(obj);
        start = -1;
      }
    }
  }
  // 尾部未闭合对象（输出截断）：fixMalformedJSON 补齐闭合符后抢救
  if (depth > 0 && start >= 0) {
    const obj = safeJSONParse(fixMalformedJSON(text.slice(start)));
    if (obj && typeof obj === 'object') results.push(obj);
  }
  return results;
}

/**
 * 🔥 工具调用 key 名漂移归一：params/arguments/args→parameters、tool/tool_name/toolName→name
 * 静默风险：{name, params:{task}} 不归一时 parameters 变 {} → sessioncreate 空任务启动会话
 * （比工具丢失更糟）。无合法 name 的对象返回 null（调用方丢弃）。
 */
export function normalizeToolAliases(item: any): { name: string; parameters: Record<string, any> } | null {
  if (!item || typeof item !== 'object') return null;
  const name = item.name ?? item.tool ?? item.tool_name ?? item.toolName;
  if (typeof name !== 'string' || !name) return null;
  const rawParams = item.parameters ?? item.params ?? item.arguments ?? item.args;
  return {
    name,
    parameters: rawParams && typeof rawParams === 'object' ? rawParams : {}
  };
}

/**
 * 🔥 意图推断最后抢救：原文含合法工具名但结构化解析全部失败（JSON 形态碎裂、
 * key 无引号、括号交叉错乱等）时，escape-aware 正则直接配对 name + task/
 * sessionId/priority 重建工具调用。key 引号可选（兼容无引号 key 的退化形态）。
 * 返回 undefined = 没抢救到（调用方按"该丢就丢"处理）。
 */
export function salvageToolsFromText(
  raw: string,
  validNames: string[]
): Array<{ name: string; parameters: Record<string, any> }> | undefined {
  const tools: Array<{ name: string; parameters: Record<string, any> }> = [];
  const seen = new Set<string>();
  // key 引号可选：既匹配 "name"/"tool"，也匹配无引号 name:/tool:
  const re = /"?(?:name|tool|tool_name|toolName)"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (!validNames.includes(name)) continue;
    const rest = raw.slice(m.index, m.index + 4000); // 覆盖超长 task 值（实测 1600+ 字符）
    const params: Record<string, any> = {};
    // task 尾引号可选：输出被 max_tokens 截断时 task 值没有闭合引号，截到内容末尾
    // 也比丢弃强（长任务描述截断仍可用；[^"\\] 遇下一个引号自然停，不越界）
    const taskMatch = rest.match(/"?(?:task|instruction)"?\s*:\s*"((?:[^"\\]|\\.)*)"?/);
    if (taskMatch) params.task = unescapeJSONString(taskMatch[1]);
    const prioMatch = rest.match(/"?(?:priority|urgent)"?\s*:\s*(true|false)/);
    if (prioMatch) params.priority = prioMatch[1] === 'true';
    const sidMatch = rest.match(/"?(?:sessionId|session_id)"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (sidMatch) params.sessionId = unescapeJSONString(sidMatch[1]);
    const key = `${name}\u0000${params.task || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({ name, parameters: params });
  }
  return tools.length ? tools : undefined;
}
