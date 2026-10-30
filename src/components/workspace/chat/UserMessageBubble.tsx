import React, { useMemo, useState } from "react";
import { Message, FileAttachment } from "../types/ChatTypes";
import FileGrid from "../common/FileGrid";
import LinkText from '../common/LinkText';
import { performance } from "@/utils/logger";
import { Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UserMessageBubbleProps {
  message: Message;
  onFileView?: (file: FileAttachment) => void;
  onFileDownload?: (file: FileAttachment) => void;
}

// 🔥 来源标签 → 时间戳旁的来源图标（未列出的来源不显示；未来 IM 渠道在此加图标）
const SOURCE_META: Record<string, { Icon: React.FC<{ className?: string }>; label: string }> = {
  email: { Icon: Mail, label: "来自离线邮件指挥" },
};

// 格式化时间戳 - 显示更友好的时间格式
const formatTimestamp = (timestamp: Date): string => {
  const now = new Date();
  const hours = timestamp.getHours().toString().padStart(2, '0');
  const minutes = timestamp.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;
  
  // 计算天数差
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());
  const diffDays = Math.floor((today.getTime() - targetDay.getTime()) / (24 * 60 * 60 * 1000));
  
  if (diffDays === 0) {
    // 今天
    return `今天 ${timeStr}`;
  } else if (diffDays === 1) {
    // 昨天
    return `昨天 ${timeStr}`;
  } else if (diffDays <= 3) {
    // 3天内
    return `${diffDays}天前 ${timeStr}`;
  } else if (diffDays <= 7) {
    // 一周内，显示星期
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${weekDays[timestamp.getDay()]}`;
  } else {
    // 更早，显示完整日期
    const month = timestamp.getMonth() + 1;
    const day = timestamp.getDate();
    return `${month}月${day}日 ${timeStr}`;
  }
};

const UserMessageBubble: React.FC<UserMessageBubbleProps> = React.memo(({ message, onFileView, onFileDownload }) => {
  const [copied, setCopied] = useState(false);
  // 🚀 性能优化：使用 useMemo 缓存文件处理结果，避免每次渲染时重复计算
  const processedFiles = useMemo(() => {
    performance("USER-MESSAGE-BUBBLE", "开始处理文件数据");

    if (!message.files || message.files.length === 0) {
      return [];
    }

    const processed = message.files
      .map((file) => {
        // 🔥 修复：优先使用 content 字段，只有在 content 无效时才使用其他字段
        const content = (file.content && file.content.length > 0) 
          ? file.content 
          : file.base64 || file.preview || "";

        return {
          ...file,
          content: content,
          // 保持向后兼容的废弃字段
          preview: content,
          base64: content,
        };
      })
      .filter((f) => f.content && f.content.length > 0); // 🔥 关键：只保留有效文件

    performance("USER-MESSAGE-BUBBLE", "文件处理完成", {
      originalCount: message.files.length,
      processedCount: processed.length,
    });

    return processed;
  }, [message.files]);

  // 复制消息内容到剪贴板
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  };

  return (
    <div className="flex justify-end mb-4">
      <div className="max-w-[70%] relative group">
        <div className="bg-[#f4f4f4] text-black px-4 py-2.5 rounded-3xl rounded-br-md antialiased">
          <div className="prose prose-sm max-w-none break-words">
            {message.content.split("\n").map((line, index) => {
              // 🔥 行内代码高亮：先按 `code` 分割，代码段用 <code> 渲染，其余走 LinkText
              const parts = line.split(/(`[^`]+`)/g);
              return (
                <p key={index} className="mb-1 text-[14px] leading-[1.75] break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                  {parts.map((part, i) => {
                    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
                      return (
                        <code key={i} className="px-1.5 py-0.5 rounded bg-black/10 text-[13px] font-mono">
                          {part.slice(1, -1)}
                        </code>
                      );
                    }
                    return <LinkText key={i} text={part} />;
                  })}
                </p>
              );
            })}
          </div>

          {/* 🔧 使用 FileGrid 替代 FileAttachments，提供更好的文件显示体验 */}
          {processedFiles && processedFiles.length > 0 && (
            <div className="mt-2 mb-1">  {/* 🔥 调整FileGrid位置，离下方更近一点 */}
              <FileGrid
                files={processedFiles}
                size="auto"
                showActions={true}
                actionsVisibility="always"
                onFileView={onFileView}
                onFileDownload={onFileDownload}
              />
            </div>
          )}
        </div>
        
        {/* 时间戳、复制按钮、来源图标 */}
        <div className="flex items-center justify-end gap-2 mt-1 px-1">
          <span className="text-xs text-gray-400">
            {message.timestamp ? formatTimestamp(message.timestamp) : ''}
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center justify-center h-4 w-4 text-gray-400 hover:text-gray-600 transition-colors"
            title={copied ? "已复制" : "复制"}
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
          {(() => {
            const meta = message.source ? SOURCE_META[message.source] : undefined;
            if (!meta) return null;
            // title 挂在外层 span（HTML 原生 tooltip，不依赖 SVG 属性）
            return (
              <span title={meta.label} className="inline-flex text-emerald-500">
                <meta.Icon className="h-3.5 w-3.5" />
              </span>
            );
          })()}
        </div>
      </div>
    </div>
  );
});

UserMessageBubble.displayName = "UserMessageBubble";

export default UserMessageBubble;
