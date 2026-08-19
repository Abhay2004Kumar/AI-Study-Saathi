const { StringOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence, RunnablePassthrough } = require('@langchain/core/runnables');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const { ragPromptTemplate } = require('../prompts/rag.prompt');

/**
 * Helper function to format an array of LangChain Document objects into a single string.
 */
const formatDocumentsAsString = (documents) => {
  if (!documents || documents.length === 0) {
    return "No relevant documents found.";
  }
  return documents.map(doc => `--- Document: ${doc.metadata.title} ---\n${doc.pageContent}\n`).join('\n');
};

/**
 * Constructs a LangChain Expression Language (LCEL) chain for RAG.
 * 
 * Flow:
 * 1. Takes { question }
 * 2. Assigns { context } by passing the question through the Retriever and formatting the docs.
 * 3. Passes { context, question } to the PromptTemplate.
 * 4. Passes formatted prompt to the LLM.
 * 5. Passes LLM response to StringOutputParser to extract the raw text.
 * 
 * @param {string} userId - The user ID to scope the retrieval to.
 * @param {object} llm - The instantiated language model (e.g., ChatGoogleGenerativeAI)
 * @returns {RunnableSequence} The executable LangChain pipeline.
 */
const createRAGChain = (userId, llm) => {
  const retriever = new PGVectorRetriever({ userId, topK: 3 });
  
  // Use LCEL to compose the chain
  const chain = RunnableSequence.from([
    {
      context: async (input) => {
        // Fetch docs and format them in one step
        const docs = await retriever.invoke(input.question);
        return formatDocumentsAsString(docs);
      },
      question: new RunnablePassthrough(), // Passes the question through unchanged
    },
    ragPromptTemplate,
    llm,
    new StringOutputParser(),
  ]);

  return { chain, retriever };
};

module.exports = { createRAGChain, formatDocumentsAsString };
