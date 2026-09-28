import React, { useEffect, useRef } from "react";
import WorkspaceLayout from "../layout/WorkspaceLayout";
import WorkspaceGrid from "../layout/WorkspaceGrid";
import { useWorkspace } from "@/hooks/workspace/useWorkspace";
import { createHandlers } from "@/hooks/workspace/useWorkspaceHandlers";
import { UserProfile } from "@/context/AuthContext";

interface AuthenticatedWorkspaceProps {
  user: UserProfile | any;
}

const AuthenticatedWorkspace: React.FC<AuthenticatedWorkspaceProps> = ({ user }) => {
  const workspace = useWorkspace();
  const handlers = createHandlers(workspace);

  // 🔥 Headless 分身桥：订阅主进程转发的 agent query（POST /api/agent/query → IPC），
  // 复用与聊天输入框完全相同的编排（handleSendMessage → SummaryHandler 内核）。
  // 仅 Electron headless 模式订阅；受理即回包，执行过程在分身内进行。
  const sendRef = useRef(handlers.handleSendMessage);
  sendRef.current = handlers.handleSendMessage;

  // 终态回包需要挖最终 summary 文本：.then 闭包里直接读 workspace.messages 可能是旧值，经 ref 取最新
  const messagesRef = useRef(workspace.messages);
  messagesRef.current = workspace.messages;

  /** 尽力而为取最近一条已完成总结（summarizer）的文本：summary 正文在 result，content 为空 */
  const pickLatestSummary = (): string | undefined => {
    const list: any[] = messagesRef.current || [];
    const last = [...list].reverse().find((m: any) => m.apiRole === 'summarizer' && m.status === 'completed');
    const text = last?.result || last?.content;
    return text ? String(text) : undefined;
  };

  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.isHeadless || !electron?.onAgentQuery) return;

    const unsub = electron.onAgentQuery(({ reqId, userQuery }: { reqId: string; userQuery: string }) => {
      console.log(`🧬 [AGENT-BRIDGE] 收到 agent query: ${userQuery.slice(0, 80)}...`);
      try {
        // 受理即回包（不阻塞 HTTP 响应等执行完成——执行结果经项目文件/GPU任务回流）
        // 任务真正收尾（handleSendMessage resolve/reject）时另发终态，供 GET /api/agent/result 轮询
        sendRef.current(userQuery)
          // 等一拍让最终 summary 落进 React state，再挖文本回终态（headless 场景百毫秒延迟无感）
          .then(() => new Promise((r) => setTimeout(r, 100)))
          .then(() => electron.agentQueryFinal?.({ reqId, ok: true, summary: pickLatestSummary() }))
          .catch((e: any) => {
            console.error('❌ [AGENT-BRIDGE] 执行编排异常:', e);
            electron.agentQueryFinal?.({ reqId, ok: false, error: e?.message || '执行异常' });
          });
        electron.agentQueryResult({ reqId, ok: true });
      } catch (e: any) {
        console.error('❌ [AGENT-BRIDGE] 受理失败:', e);
        electron.agentQueryResult({ reqId, ok: false, error: e?.message || '受理失败' });
      }
    });
    console.log('🧬 [AGENT-BRIDGE] Headless agent query 桥已订阅');
    return unsub;
  }, []);

  return (
    <WorkspaceLayout>
      <WorkspaceGrid
        messages={workspace.messages}
        isProcessing={workspace.isProcessing}
        currentConversationId={workspace.currentConversationId}
        userId={workspace.userId}
        onLoadMoreMessages={handlers.handleLoadMoreMessages}
        onSendMessage={handlers.handleSendMessage}
        onNewChat={handlers.handleNewChat}
        onCancel={handlers.handleCancel}
      />
    </WorkspaceLayout>
  );
};

export default AuthenticatedWorkspace;
