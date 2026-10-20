/**
 * docParser - 项目文档内容提取（read_project_file 的文档分流层）
 *
 * 背景：userpcFile.read 对二进制（docx/xlsx/pdf 等）返回 base64，LLM 读到的是噪音。
 * 本模块把浏览器端现成的解析依赖接进 LLM 工具链：
 * - .docx → mammoth 提取纯文本（保留段落，格式/图片不保留）
 * - .xlsx/.xls → SheetJS 逐 sheet 转 CSV（每 sheet 截前 500 行）
 * - .pdf → pdfjs 逐页提取文本（页码标注，最多 50 页）
 *
 * 设计原则：解析失败或类型不支持返回 null（调用方回退报错提示），宁可缺失不可错误。
 * 独立成文件：mammoth/SheetJS/pdfjs 三个动态 import 与 buffer 转换全部收拢于此，
 * TrainProjectFileTools.ts 只做 ext 分流调用，避免继续膨胀。
 */

/** 支持提取文本的文档扩展名 */
export const DOC_PARSE_EXTS = ['docx', 'xlsx', 'xls', 'pdf'];

/**
 * 高危二进制（主进程 base64 名单外，utf-8 硬读会产出纯乱码）。
 * 覆盖：可执行/库文件、python 字节码、模型权重、序列化对象。
 */
export const BINARY_TRAP_EXTS = [
  'exe', 'dll', 'so', 'dylib', 'pyc', 'pyd',
  'pt', 'pth', 'onnx', 'bin', 'h5', 'pkl', 'pickle', 'npy', 'npz',
];

/**
 * 二进制文件的分层读取指引（按类型给最短处理路径）。
 * 分层思想：read 分流只服务"看"的场景（1 轮拿到文本）；
 * "算"（筛选/统计/转换/生成）一律指向 python——那是唯一正解，CSV 给 LLM 看帮不上运算。
 */
export function docReadError(ext: string): string {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(ext)) {
    return `图片（.${ext}）无法提取文本。查看：先 uploadfiletooss 上传，再用 web_url_reader 阅读；本地处理用 python (PIL)`;
  }
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav'].includes(ext)) {
    return `音视频（.${ext}）无法提取文本。可先 uploadfiletooss 上传后用 web_url_reader 阅读元信息，或用 python (ffprobe/moviepy) 处理`;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return `压缩包（.${ext}）无法直接读取。用 python/unzip 解压后，再 read 其中的文本文件`;
  }
  if (['doc', 'ppt', 'pptx'].includes(ext)) {
    return `.${ext} 无内置解析。用 python (python-pptx/python-docx) 或 LibreOffice 转换为 docx/pdf 后再读取`;
  }
  if (DOC_PARSE_EXTS.includes(ext)) {
    return `.${ext} 解析失败。用 python (pandas/python-docx/pypdf) 读取，或确认文件未损坏`;
  }
  return `二进制文件（.${ext}）无法按文本读取，请用 python 处理`;
}

export interface DocParseResult {
  /** 提取出的文本内容 */
  text: string;
  /** 提取说明（附在内容头部，让 LLM 知道这是转换产物） */
  note: string;
}

/** base64 → ArrayBuffer（复用 OfficeViewer 的转换套路） */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** 每个文档类型的提取预算（在解析层先收一道，最终 12KB 截断由调用方统一做） */
const DOCX_MAX_CHARS = 60000;
const EXCEL_MAX_ROWS_PER_SHEET = 500;
const PDF_MAX_PAGES = 50;

async function parseDocx(buffer: ArrayBuffer): Promise<DocParseResult | null> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    let text = result.value || '';
    if (!text.trim()) return null;
    if (text.length > DOCX_MAX_CHARS) {
      text = `${text.slice(0, DOCX_MAX_CHARS)}\n...[文档过长，已截断，原文 ${result.value.length} 字符]`;
    }
    return { text, note: '📄 docx 文档已提取纯文本（段落保留，格式/图片不保留）' };
  } catch {
    return null;
  }
}

async function parseExcel(buffer: ArrayBuffer, ext: string): Promise<DocParseResult | null> {
  try {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buffer, { type: 'array' });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      const lines = csv.split('\n');
      if (lines.length > EXCEL_MAX_ROWS_PER_SHEET) {
        parts.push(`## Sheet: ${name}（共 ${lines.length - 1} 行，已截取前 ${EXCEL_MAX_ROWS_PER_SHEET} 行）\n${lines.slice(0, EXCEL_MAX_ROWS_PER_SHEET).join('\n')}`);
      } else {
        parts.push(`## Sheet: ${name}\n${csv}`);
      }
    }
    const text = parts.join('\n\n');
    if (!text.trim()) return null;
    return { text, note: `📊 ${ext} 表格已转为 CSV（每个 sheet 一段，表头为首行）。需要筛选/统计/运算请直接写 python (pandas)，勿逐行看 CSV` };
  } catch {
    return null;
  }
}

async function parsePdf(buffer: ArrayBuffer): Promise<DocParseResult | null> {
  try {
    const pdfjs = await import('pdfjs-dist');
    // vite 标准做法：?url 后缀把 worker 作为 asset 引入
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    const maxPages = Math.min(doc.numPages, PDF_MAX_PAGES);
    const parts: string[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const pageText = tc.items.map((it: any) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (pageText) parts.push(`--- 第 ${p} 页 ---\n${pageText}`);
    }
    const text = parts.join('\n\n');
    if (!text.trim()) return null;
    return {
      text,
      note: `📕 PDF 共 ${doc.numPages} 页${maxPages < doc.numPages ? `，已提取前 ${maxPages} 页文本` : '，已全部提取文本'}（排版/图片不保留）`,
    };
  } catch {
    return null;
  }
}

/**
 * 解析文档二进制为文本。类型不支持或解析失败返回 null（调用方自行回退）。
 * @param base64 userpcFile.read(path, 'base64') 返回的内容
 * @param ext    小写扩展名（不含点）
 */
export async function parseDocFile(base64: string, ext: string): Promise<DocParseResult | null> {
  if (!base64) return null;
  try {
    const buffer = base64ToArrayBuffer(base64);
    switch (ext) {
      case 'docx': return await parseDocx(buffer);
      case 'xlsx':
      case 'xls': return await parseExcel(buffer, ext);
      case 'pdf': return await parsePdf(buffer);
      default: return null;
    }
  } catch {
    return null;
  }
}
