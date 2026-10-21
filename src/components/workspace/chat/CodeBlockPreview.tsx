/**
 * CodeBlockPreview - 折叠式代码块预览组件
 * 
 * 🔥 仅做视觉预览，textarea 中不显示代码
 * 🔥 发送时自动展开为完整格式
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, Copy, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export interface CodeBlockData {
  appId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  code: string;
}

interface CodeBlockPreviewProps {
  data: CodeBlockData;
  onRemove?: () => void;
}

/**
 * 从文本中提取代码块标记
 * 格式: [[CODE_BLOCK:base64EncodedJson]]
 */
export function extractCodeBlockMarkers(text: string): {
  markers: Array<{ id: string; data: CodeBlockData; startIndex: number; endIndex: number }>;
  displayText: string;
} {
  const markers: Array<{ id: string; data: CodeBlockData; startIndex: number; endIndex: number }> = [];
  
  // 匹配 [[CODE_BLOCK:xxx]]
  const regex = /\[\[CODE_BLOCK:([A-Za-z0-9+/=]+)\]\]/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    try {
      const decoded = decodeURIComponent(atob(match[1]));
      const data = JSON.parse(decoded) as CodeBlockData;
      const id = `cb-${match.index}`;
      
      markers.push({
        id,
        data,
        startIndex: match.index,
        endIndex: match.index + match[0].length
      });
    } catch (e) {
      console.error('[CodeBlockPreview] 解析失败:', e);
    }
  }
  
  // 🔥 从显示文本中移除标记：必须用副本降序排序（从后往前删避免索引位移）——
  //    原地 sort 会翻转 markers 顺序，导致输入框重建标记时块顺序每键翻转一次（UI 上下互换）
  let displayText = text;
  markers.slice().sort((a, b) => b.startIndex - a.startIndex).forEach(marker => {
    displayText = displayText.slice(0, marker.startIndex) + displayText.slice(marker.endIndex);
  });
  
  // 🔥 仅当存在代码块标记时，去掉标记移除后残留的一个分隔空格（重建时的 markerTexts + ' '）
  // 注意：普通文本绝不能 trimStart！否则用户在文本开头插入的换行（Shift+Enter）会被吃掉，
  // 导致受控组件的 value 与 DOM 实际值不一致，React 强制重设 value 后光标会跳到末尾
  if (markers.length > 0) {
    displayText = displayText.replace(/^ /, '');
  }
  
  return { markers, displayText };
}

/**
 * 将代码块数据展开为 LLM 可读格式
 */
export function expandCodeBlockForLLM(data: CodeBlockData): string {
  const lines = data.endLine - data.startLine + 1;
  const lineInfo = lines > 1 
    ? `第 ${data.startLine}-${data.endLine} 行`
    : `第 ${data.startLine} 行`;
  
  return `📁 文件: ${data.filePath}
${data.appId ? `🔑 appId: ${data.appId}\n` : ''}📍 位置: ${lineInfo}

\`\`\`${data.language}
${data.code}
\`\`\``;
}

/**
 * 将输入文本中的所有标记展开为完整格式
 */
export function expandAllCodeBlocks(text: string): string {
  const { markers, displayText } = extractCodeBlockMarkers(text);
  
  if (markers.length === 0) {
    return text;
  }
  
  const expandedBlocks = markers.map(m => expandCodeBlockForLLM(m.data));
  const userText = displayText.trim();
  
  if (userText) {
    return [...expandedBlocks, userText].join('\n\n');
  }
  
  return expandedBlocks.join('\n\n');
}

/**
 * 折叠式代码块预览组件
 */
export const CodeBlockPreview: React.FC<CodeBlockPreviewProps> = ({ 
  data,
  onRemove 
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  
  const lineCount = data.endLine - data.startLine + 1;
  const lineInfo = lineCount > 1 
    ? `第 ${data.startLine}-${data.endLine} 行`
    : `第 ${data.startLine} 行`;
  
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    try {
      await navigator.clipboard.writeText(data.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      
      toast({
        title: "已复制代码",
        duration: 1500,
      });
    } catch (error) {
      const textArea = document.createElement('textarea');
      textArea.value = data.code;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove?.();
  };
  
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg overflow-hidden my-1 text-xs">
      {/* 头部 - 始终显示 */}
      <div 
        className="flex items-center justify-between px-3 py-2 bg-blue-100 cursor-pointer hover:bg-blue-200 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
          )}
          <FileCode className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
          <span className="font-medium text-blue-800 truncate max-w-[200px]">
            {data.filePath}
          </span>
          <span className="text-blue-600 flex-shrink-0">
            {lineInfo}
          </span>
          <span className="text-blue-400 flex-shrink-0">
            ({lineCount} 行)
          </span>
        </div>
        
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 hover:bg-blue-200"
            onClick={handleCopy}
            title="复制代码"
          >
            {copied ? (
              <Check className="w-3 h-3 text-green-600" />
            ) : (
              <Copy className="w-3 h-3 text-blue-600" />
            )}
          </Button>
          {onRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 hover:bg-blue-200"
              onClick={handleRemove}
              title="移除"
            >
              <X className="w-3 h-3 text-blue-600" />
            </Button>
          )}
        </div>
      </div>
      
      {/* 展开内容 - 代码预览 */}
      {isExpanded && (
        <div className="border-t border-blue-200">
          {data.appId && (
            <div className="px-3 py-1.5 bg-blue-100 text-blue-700 border-b border-blue-200">
              appId: {data.appId}
            </div>
          )}
          <div className="max-h-32 overflow-auto bg-white">
            <pre className="p-2 font-mono text-gray-700 whitespace-pre-wrap break-all text-[11px]">
              {data.code.length > 300 
                ? data.code.slice(0, 300) + '\n...'
                : data.code
              }
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default CodeBlockPreview;
