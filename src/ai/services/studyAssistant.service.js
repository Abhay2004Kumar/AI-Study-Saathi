const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const prisma = require('../../config/db');
const { buildStudyAssistantAgent } = require('../graphs/studyAssistant.graph');

// Bounds how much prior conversation gets replayed into the model each
// turn — keeps prompt size/cost predictable for a session that could
// otherwise grow indefinitely.
const MAX_HISTORY_MESSAGES = 20;

class StudyAssistantService {
  static async getSession(userId, examId) {
    return prisma.assistantSession.findUnique({ where: { examId_userId: { examId, userId } } });
  }

  /**
   * Sends one user message to the exam-scoped assistant agent and persists
   * both sides of the exchange. The agent answers by calling tools bound to
   * this exact (userId, examId) — see studyAssistant.graph.js — so it can
   * only ever see and act on this user's own data for this exam.
   *
   * @returns {Promise<{reply: string, toolsUsed: string[], sessionId: string}|null>} null if the exam doesn't belong to this user
   */
  static async sendMessage(userId, examId, message) {
    const exam = await prisma.exam.findFirst({ where: { id: examId, userId } });
    if (!exam) return null;

    const existing = await prisma.assistantSession.findUnique({ where: { examId_userId: { examId, userId } } });
    const priorMessages = existing ? existing.messages : [];

    const history = priorMessages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));

    const agent = buildStudyAssistantAgent(userId, examId);
    const result = await agent.invoke({ messages: [...history, new HumanMessage(message)] });

    const lastMessage = result.messages[result.messages.length - 1];
    const reply = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);

    // What the agent actually did this turn, not its own unverifiable claim
    // of what it did — read straight off the tool-call messages it emitted.
    const toolsUsed = [
      ...new Set(
        result.messages
          .filter((m) => m instanceof AIMessage && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
          .flatMap((m) => m.tool_calls.map((tc) => tc.name))
      ),
    ];

    const now = new Date();
    const updatedMessages = [
      ...priorMessages,
      { role: 'user', content: message, createdAt: now },
      { role: 'assistant', content: reply, toolsUsed, createdAt: now },
    ];

    const session = await prisma.assistantSession.upsert({
      where: { examId_userId: { examId, userId } },
      create: { userId, examId, messages: updatedMessages },
      update: { messages: updatedMessages },
    });

    return { reply, toolsUsed, sessionId: session.id };
  }
}

module.exports = StudyAssistantService;
