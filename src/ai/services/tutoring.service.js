const prisma = require('../../config/db');
const { buildStartGraph, buildRespondGraph } = require('../graphs/tutoring.graph');

class TutoringService {
  /**
   * Starts a new tutoring session for a given topic.
   * Runs the start graph (retrieve + explain + ask) and saves state to DB.
   * 
   * @param {string} userId
   * @param {string} subject
   * @param {string} topic
   * @returns {{ sessionId, aiMessage, questionCount }}
   */
  static async startSession(userId, subject, topic) {
    const startGraph = buildStartGraph();

    const initialState = {
      userId,
      subject,
      topic,
      currentConcept: `Introduction to ${topic}`,
      conversationHistory: [],
      weakAreas: [],
      questionCount: 0,
    };

    const finalState = await startGraph.invoke(initialState);

    // Persist session to PostgreSQL
    const session = await prisma.tutorSession.create({
      data: {
        userId,
        subject,
        topic,
        status: 'ACTIVE',
        currentConcept: finalState.currentConcept,
        conversationHistory: finalState.conversationHistory,
        weakAreas: finalState.weakAreas,
        questionCount: 1, // First exchange counts as question 1
      }
    });

    return {
      sessionId: session.id,
      aiMessage: finalState.aiMessage,
      questionCount: session.questionCount,
      sessionStatus: 'ACTIVE',
    };
  }

  /**
   * Processes a student's answer, runs the respond graph, and updates session state.
   * 
   * @param {string} sessionId
   * @param {string} studentAnswer
   * @returns {{ aiMessage, questionCount, sessionStatus, weakAreas }}
   */
  static async respond(sessionId, studentAnswer) {
    // 1. Load existing session from DB
    const session = await prisma.tutorSession.findUnique({
      where: { id: sessionId }
    });

    if (!session) throw new Error('Session not found');
    if (session.status === 'COMPLETED') {
      return {
        aiMessage: 'This tutoring session has already been completed.',
        sessionStatus: 'COMPLETED',
        questionCount: session.questionCount,
        weakAreas: session.weakAreas,
      };
    }

    const respondGraph = buildRespondGraph();

    // 2. Build state from saved session + new student answer
    const state = {
      userId: session.userId,
      subject: session.subject,
      topic: session.topic,
      currentConcept: session.currentConcept,
      conversationHistory: session.conversationHistory,
      weakAreas: session.weakAreas,
      questionCount: session.questionCount,
      studentAnswer,
    };

    // 3. Run the respond graph
    const finalState = await respondGraph.invoke(state);

    const newStatus = finalState.sessionStatus === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE';

    // 4. Update session in DB
    await prisma.tutorSession.update({
      where: { id: sessionId },
      data: {
        status: newStatus,
        currentConcept: finalState.currentConcept || session.currentConcept,
        conversationHistory: finalState.conversationHistory,
        weakAreas: finalState.weakAreas,
        questionCount: finalState.questionCount,
      }
    });

    return {
      aiMessage: finalState.aiMessage,
      questionCount: finalState.questionCount,
      sessionStatus: newStatus,
      weakAreas: finalState.weakAreas,
    };
  }

  /**
   * Retrieves a session's full details including conversation history.
   * 
   * @param {string} sessionId
   * @param {string} userId - Used to verify ownership
   */
  static async getSession(sessionId, userId) {
    const session = await prisma.tutorSession.findFirst({
      where: { id: sessionId, userId }
    });
    if (!session) throw new Error('Session not found');
    return session;
  }
}

module.exports = TutoringService;
