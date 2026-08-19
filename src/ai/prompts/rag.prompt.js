const { ChatPromptTemplate } = require('@langchain/core/prompts');

/**
 * Creates the standard RAG prompt template used across the application.
 */
const ragPromptTemplate = ChatPromptTemplate.fromMessages([
  ["system", `You are a helpful AI Study Companion. 
Use the provided context extracted from the user's study materials to answer the question.
If the answer is not contained in the context, you can say "I don't see that in your notes, but based on general knowledge..." and then answer it.

CONTEXT:
{context}`],
  ["human", "{question}"]
]);

module.exports = { ragPromptTemplate };
