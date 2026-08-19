const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const config = require('../../config/env');
const { createRAGChain } = require('../chains/rag.chain');

class RAGService {
  constructor() {
    this.llm = new ChatGoogleGenerativeAI({
      apiKey: config.gemini.apiKey,
      model: 'gemini-3.5-flash-lite',
      temperature: 0.2, // Low temperature for more factual answers
    });
  }

  /**
   * Retrieves relevant chunks from the database and uses them to answer the user's question
   * @param {string} userId The ID of the user asking the question
   * @param {string} question The user's question
   * @returns {Promise<string>} The generated answer
   */
  async askQuestion(userId, question) {
    if (!question) {
      throw new Error("Question cannot be empty");
    }

    try {
      // 1. Build the LCEL Chain with our initialized LLM and user scope
      const { chain, retriever } = createRAGChain(userId, this.llm);

      // 2. We can fetch the documents in parallel if we need their titles for the sources.
      // But retriever.invoke is available for us to fetch sources easily.
      const docs = await retriever.invoke(question);

      // 3. Invoke the LangChain pipeline to get the final answer string!
      const answer = await chain.invoke({ question: question });

      return {
        answer: answer,
        sources: docs.map(doc => doc.metadata.title)
      };
    } catch (error) {
      console.error("LangChain Generation failed:", error);
      throw new Error("Failed to generate an answer");
    }
  }
}

module.exports = new RAGService();
