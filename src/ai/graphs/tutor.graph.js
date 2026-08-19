const { StateGraph, START, END } = require('@langchain/langgraph');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const config = require('../../config/env');

// Initialize LLMs
const llm = new ChatGoogleGenerativeAI({
  apiKey: config.gemini.apiKey,
  model: 'gemini-3.5-flash-lite',
  temperature: 0.2,
});

// A slightly more creative LLM for rewriting queries
const rewriteLlm = new ChatGoogleGenerativeAI({
  apiKey: config.gemini.apiKey,
  model: 'gemini-3.5-flash-lite',
  temperature: 0.7,
});

// 1. Define the State
const tutorState = {
  userId: { value: (x, y) => y ?? x, default: () => "" },
  question: { value: (x, y) => y ?? x, default: () => "" },
  searchQuery: { value: (x, y) => y ?? x, default: () => "" },
  retrievedDocuments: { value: (x, y) => y ?? x, default: () => [] },
  answer: { value: (x, y) => y ?? x, default: () => "" },
  needsMoreContext: { value: (x, y) => y ?? x, default: () => false },
  loopCount: { value: (x, y) => y ?? x, default: () => 0 },
};

// 2. Define the Nodes

// NODE: Analyze the question and set the initial search query
const analyzeQuestionNode = async (state) => {
  console.log("--- NODE: ANALYZE QUESTION ---");
  // For the first pass, the search query is exactly the user's question
  return { searchQuery: state.question };
};

// NODE: Retrieve context from PostgreSQL
const retrieveContextNode = async (state) => {
  console.log(`--- NODE: RETRIEVE CONTEXT (Loop ${state.loopCount}) ---`);
  const retriever = new PGVectorRetriever({ userId: state.userId, topK: 3 });
  const docs = await retriever.invoke(state.searchQuery);

  // Combine existing documents with newly retrieved ones (if any)
  // To avoid duplicates, we can just overwrite for simplicity in this MVP
  return { retrievedDocuments: docs };
};

// NODE: Generate the answer
const generateAnswerNode = async (state) => {
  console.log("--- NODE: GENERATE ANSWER ---");

  const context = state.retrievedDocuments.length > 0
    ? state.retrievedDocuments.map(d => d.pageContent).join('\n\n')
    : "No relevant documents found.";

  const prompt = `You are an AI Tutor. Answer the user's question based strictly on the context provided.
  If the context does not contain the answer, say "I don't have enough information in your notes to answer that."
  
  CONTEXT:
  ${context}
  
  QUESTION:
  ${state.question}
  
  ANSWER:`;

  const response = await llm.invoke(prompt);
  return { answer: response.content };
};

// NODE: Evaluate if the answer is good or if it needs more context
const evaluateAnswerNode = async (state) => {
  console.log("--- NODE: EVALUATE ANSWER ---");

  // If we already looped twice, stop to prevent infinite loops
  if (state.loopCount >= 2) {
    return { needsMoreContext: false };
  }

  // Check if the LLM admitted it doesn't know
  const answerLower = state.answer.toLowerCase();
  if (answerLower.includes("don't have enough information") || answerLower.includes("does not contain")) {
    console.log("Evaluation: Needs more context.");
    return { needsMoreContext: true, loopCount: state.loopCount + 1 };
  }

  return { needsMoreContext: false };
};

// NODE: Rewrite the query to try fetching better context
const rewriteQueryNode = async (state) => {
  console.log("--- NODE: REWRITE QUERY ---");

  const prompt = `The previous search for "${state.searchQuery}" did not yield enough information to answer the question: "${state.question}".
  Provide a new, alternative search query (just the string, no quotes or intro) that might find better results in a vector database.`;

  const response = await rewriteLlm.invoke(prompt);
  const newQuery = response.content.trim();

  console.log(`Rewrote query to: ${newQuery}`);
  return { searchQuery: newQuery };
};

// 3. Define the Graph Edges
const workflow = new StateGraph({ channels: tutorState })
  .addNode("analyzeQuestion", analyzeQuestionNode)
  .addNode("retrieveContext", retrieveContextNode)
  .addNode("generateAnswer", generateAnswerNode)
  .addNode("evaluateAnswer", evaluateAnswerNode)
  .addNode("rewriteQuery", rewriteQueryNode)

  // Standard execution path
  .addEdge(START, "analyzeQuestion")
  .addEdge("analyzeQuestion", "retrieveContext")
  .addEdge("retrieveContext", "generateAnswer")
  .addEdge("generateAnswer", "evaluateAnswer")

  // Conditional routing after evaluation
  .addConditionalEdges("evaluateAnswer", (state) => {
    return state.needsMoreContext ? "needs_more" : "complete";
  }, {
    "needs_more": "rewriteQuery",
    "complete": END
  })

  // After rewriting, loop back to retrieval
  .addEdge("rewriteQuery", "retrieveContext");

// Compile the graph
const tutorGraph = workflow.compile();

module.exports = { tutorGraph };
