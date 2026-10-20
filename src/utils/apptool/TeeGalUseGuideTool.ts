import { useGuideKnowledgeBase, KnowledgeItem } from '@/utils/auto/knowledge/useGuideData';
import { AutoStep, AutoToolResult } from '@/utils/auto/types';

export interface TeeGalUseGuideInput {
  query: string;
}

export interface TeeGalUseGuideOutput {
  success: boolean;
  content: string;
  matchedItems: string[];
  relatedTopics: string[];
  codebaseResults?: string;
}

let cachedProjectRoot: string | null = null;

function matchScore(query: string, item: KnowledgeItem): number {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,，?？、]+/).filter(w => w.length > 1);

  let score = 0;

  for (const keyword of item.keywords) {
    const kwLower = keyword.toLowerCase();
    if (queryLower.includes(kwLower)) {
      score += 10;
    }
    if (kwLower.includes(queryLower)) {
      score += 5;
    }
    for (const word of queryWords) {
      if (kwLower.includes(word) || word.includes(kwLower)) {
        score += 3;
      }
    }
  }

  const questionLower = item.question.toLowerCase();
  if (queryLower.includes(questionLower) || questionLower.includes(queryLower)) {
    score += 20;
  }
  for (const word of queryWords) {
    if (questionLower.includes(word)) {
      score += 4;
    }
  }

  const answerLower = item.answer.toLowerCase();
  for (const word of queryWords) {
    if (answerLower.includes(word)) {
      score += 2;
    }
  }

  return score;
}

function searchKnowledge(query: string): { items: KnowledgeItem[]; topics: string[] } {
  const scored = useGuideKnowledgeBase
    .map(item => ({ item, score: matchScore(query, item) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const items = scored.slice(0, 2).map(s => s.item);
  const topics = [...new Set(items.map(i => i.category))];

  if (items.length === 0) {
    const fallback = useGuideKnowledgeBase.slice(0, 2);
    return { items: fallback, topics: [...new Set(fallback.map(i => i.category))] };
  }

  return { items, topics };
}

async function getProjectRoot(): Promise<string | null> {
  if (cachedProjectRoot) return cachedProjectRoot;

  try {
    if (typeof window === 'undefined' || !(window as any).electron?.systemCommand) {
      return null;
    }

    // 🔥 Windows → PowerShell 扫描；macOS/Linux → find（bash 通道），验证 src/utils 存在防误中同名目录
    const isWin = (window as any).electron?.platform === 'win32';
    const command = isWin
      ? `Get-ChildItem -Path $env:USERPROFILE -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(teegal|bbone-tagalong)$' -and (Test-Path "$($_.FullName)\\src\\utils") } | Select-Object -First 1 -ExpandProperty FullName`
      : `find ~ -maxdepth 4 -type d \\( -name teegal -o -name bbone-tagalong \\) 2>/dev/null | while read d; do [ -d "$d/src/utils" ] && echo "$d" && break; done`;

    const result = await (window as any).electron.systemCommand({
      command,
      timeout: 20,
    });

    if (result.success && result.output && result.output.trim().length > 0) {
      cachedProjectRoot = result.output.trim().split('\n')[0].trim();
      return cachedProjectRoot;
    }

    return null;
  } catch {
    return null;
  }
}

async function searchCodebase(query: string): Promise<string | null> {
  try {
    if (typeof window === 'undefined' || !(window as any).electron?.systemCommand) {
      return null;
    }

    const words = query
      .replace(/[?？，,、.。！!]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 3);

    if (words.length === 0) return null;

    const projectRoot = await getProjectRoot();
    if (!projectRoot) return null;

    const pattern = words.join('|');

    const cmd = `Set-Location "${projectRoot}"; Get-ChildItem -Path "src\\utils","src\\components","src\\services" -Recurse -Include *.ts,*.tsx -ErrorAction SilentlyContinue | Select-String -Pattern "${pattern}" -SimpleMatch | Select-Object -First 15 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`;

    const result = await (window as any).electron.systemCommand({
      command: cmd,
      timeout: 15,
    });

    if (result.success && result.output && result.output.trim().length > 0) {
      return result.output.trim();
    }

    return null;
  } catch {
    return null;
  }
}

function buildResponse(
  query: string,
  items: KnowledgeItem[],
  topics: string[],
  codebaseResults?: string
): TeeGalUseGuideOutput {
  let content = `📋 TeeGal 使用指南查询: "${query}"\n\n`;

  for (const item of items) {
    content += `**${item.question}**\n${item.answer}\n\n`;
  }

  if (codebaseResults) {
    content += `---\n📂 代码库搜索结果:\n\`\`\`\n${codebaseResults}\n\`\`\`\n`;
  }

  return {
    success: true,
    content: content.trim(),
    matchedItems: items.map(i => i.question),
    relatedTopics: topics,
    codebaseResults: codebaseResults || undefined,
  };
}

export function teeGalUseGuideToolSync(input: TeeGalUseGuideInput): TeeGalUseGuideOutput {
  try {
    const { items, topics } = searchKnowledge(input.query);
    return buildResponse(input.query, items, topics);
  } catch (error) {
    return {
      success: false,
      content: `查询失败: ${error instanceof Error ? error.message : '未知错误'}`,
      matchedItems: [],
      relatedTopics: [],
    };
  }
}

export async function teeGalUseGuideTool(input: TeeGalUseGuideInput): Promise<TeeGalUseGuideOutput> {
  try {
    const { items, topics } = searchKnowledge(input.query);

    const codebaseResults = await searchCodebase(input.query);

    return buildResponse(input.query, items, topics, codebaseResults || undefined);
  } catch (error) {
    return {
      success: false,
      content: `查询失败: ${error instanceof Error ? error.message : '未知错误'}`,
      matchedItems: [],
      relatedTopics: [],
    };
  }
}

export async function executeTeeGalUseGuideTool(
  step: AutoStep,
  planId: string,
  context: { userId: string; conversationId: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || {};
  const result = await teeGalUseGuideTool({ query: params.query });

  return {
    success: result.success,
    data: result.content,
    metadata: { result },
  };
}
