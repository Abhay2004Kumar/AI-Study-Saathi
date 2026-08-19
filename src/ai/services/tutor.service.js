const { tutorGraph } = require('../graphs/tutor.graph');

class TutorService {
  /**
   * Invokes the LangGraph AI Tutor workflow.
   * @param {number} userId 
   * @param {string} question 
   * @returns {Promise<Object>} The final answer and the documents used.
   */
  async askTutor(userId, question) {
    if (!question) {
      throw new Error("Question cannot be empty");
    }

    try {
      // The state structure requires userId and question to kick off
      const initialState = {
        userId: userId,
        question: question,
        searchQuery: "",
        retrievedDocuments: [],
        answer: "",
        needsMoreContext: false,
        loopCount: 0
      };

      // Invoke the compiled StateGraph
      const finalState = await tutorGraph.invoke(initialState);

      return {
        answer: finalState.answer,
        sources: finalState.retrievedDocuments.map(doc => doc.metadata.title),
        loops: finalState.loopCount
      };
    } catch (error) {
      console.error("LangGraph Execution failed:", error);
      throw new Error("Failed to generate tutor response");
    }
  }
}

module.exports = new TutorService();
