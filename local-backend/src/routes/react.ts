/**
 * ReAct 服务路由 - /react/*
 *
 * 职责:
 * - 只负责 ReAct 推理（Thought + Action）
 * - 不执行工具，工具执行由前端完成
 */
import { Router } from 'express';
import { reActService } from '../planreactionloop/ReActService';

const router = Router();

/**
 * 执行单轮 ReAct 推理
 * POST /react/round
 *
 * 请求体:
 * {
 *   roundNumber: number;
 *   sessionId: string;
 *   userId: string;
 *   conversationId: string;
 *   userQuery: string;
 *   letAgentTodo: string;
 *   thinkingResult?: { say_to_user?: string };
 *   availableTools: Array<{ name: string; description: string }>;
 *   previousRounds: Array<...>;
 * }
 *
 * 响应:
 * {
 *   success: boolean;
 *   roundNumber: number;
 *   thought: string;
 *   action: { toolName: string; parameters: Record<string, any> };
 *   error?: string;
 * }
 */
router.post('/round', async (req, res) => {
  try {
    const request = req.body;

    // 参数验证
    if (!request.sessionId || !request.userId || !request.conversationId) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数: sessionId, userId, conversationId',
      });
    }

    if (!request.letAgentTodo) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数: letAgentTodo',
      });
    }

    console.log('[REACT-ROUTE] 接收 ReAct 推理请求:', {
      sessionId: request.sessionId,
      roundNumber: request.roundNumber,
      hasEnvironmentText: !!request.environmentText,
    });

    // 调用 ReAct 服务
    const result = await reActService.executeRound(request);

    if (!result.success) {
      console.error('[REACT-ROUTE] ReAct 推理失败:', result.error);
      return res.status(500).json(result);
    }

    console.log('[REACT-ROUTE] ReAct 推理完成:', {
      sessionId: request.sessionId,
      roundNumber: result.roundNumber,
      toolCount: result.tools.length,
      // 🔥 tools 为空时显示 '-'（曾误写 'complete'，让「解析失败无信号」看着像结束信号，误导排查）
      firstTool: result.tools[0]?.name || '-',
    });

    res.json(result);
  } catch (error) {
    console.error('[REACT-ROUTE] ReAct 推理异常:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'ReAct 推理异常',
    });
  }
});

export default router;
