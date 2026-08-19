const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const config = require('../../config/env');

class EmbeddingService {
  constructor() {
    this.embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: config.gemini.apiKey,
      modelName: 'gemini-embedding-2',
    });
  }

  /**
   * Generates a vector embedding for a single string of text
   * @param {string} text 
   * @returns {Promise<number[]>} Array of floating point numbers (the vector)
   */
  async generateEmbedding(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a valid string');
    }
    
    try {
      const vector = await this.embeddings.embedQuery(text);
      return vector;
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      throw new Error('Embedding generation failed');
    }
  }

  /**
   * Generates embeddings for an array of strings
   * @param {string[]} texts 
   * @returns {Promise<number[][]>} Array of vectors
   */
  async generateEmbeddings(texts) {
    if (!Array.isArray(texts)) {
      throw new Error('Input must be an array of strings');
    }

    try {
      const vectors = await this.embeddings.embedDocuments(texts);
      return vectors;
    } catch (error) {
      console.error('Failed to generate multiple embeddings:', error);
      throw new Error('Embeddings generation failed');
    }
  }
}

// Export as a singleton
module.exports = new EmbeddingService();
