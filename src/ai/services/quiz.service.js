const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { z } = require('zod');
const { RunnableSequence } = require('@langchain/core/runnables');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const config = require('../../config/env');

// 1. Define the exact JSON structure we want using Zod
const quizSchema = z.object({
  subject: z.string().describe("The subject of the quiz"),
  topic: z.string().describe("The specific topic of the quiz"),
  difficulty: z.enum(["easy", "medium", "hard"]).describe("The difficulty level"),
  questions: z.array(
    z.object({
      question: z.string().describe("The text of the multiple choice question"),
      options: z.array(z.string()).describe("An array of exactly 4 possible options"),
      correctAnswer: z.string().describe("The exact text of the correct option"),
      explanation: z.string().describe("An explanation of why this answer is correct"),
      source: z.string().optional().describe("The name of the document or source where this information was found")
    })
  ).describe("The array of quiz questions")
});

class QuizService {
  /**
   * Generates a structured multiple-choice quiz based on retrieved context.
   * 
   * @param {string} userId - The user ID for retrieving their specific documents.
   * @param {string} subject - The subject (e.g., 'DBMS').
   * @param {string} topic - The topic (e.g., 'Normalization').
   * @param {number} numberOfQuestions - How many questions to generate.
   * @param {string} difficulty - Difficulty level.
   * @returns {Promise<Object>} The generated quiz JSON object.
   */
  static async generateQuiz(userId, subject, topic, numberOfQuestions = 5, difficulty = 'medium') {
    // 2. Initialize the StructuredOutputParser
    const parser = StructuredOutputParser.fromZodSchema(quizSchema);

    // 3. Retrieve relevant context from the user's documents
    const searchQuery = `${subject} ${topic} concepts and principles`;
    const retriever = new PGVectorRetriever({ userId, topK: 10 });
    const docs = await retriever.invoke(searchQuery);

    const contextText = docs.map(doc => `Source: ${doc.metadata.title || 'Unknown'}\nContent: ${doc.pageContent}`).join('\n\n');

    // 4. Initialize the LLM (Using lower temperature for more deterministic, structured output)
    const llm = new ChatGoogleGenerativeAI({
      model: "gemini-3.5-flash-lite",
      temperature: 0.8, // High temperature for diverse/random questions
      apiKey: config.gemini.apiKey,
    });

    // 5. Create the prompt template, injecting the format instructions provided by the parser
    const prompt = PromptTemplate.fromTemplate(`
You are an expert educational AI tutor. Your task is to generate a multiple-choice quiz based on the provided context.

SUBJECT: {subject}
TOPIC: {topic}
DIFFICULTY: {difficulty}
NUMBER OF QUESTIONS: {numberOfQuestions}
RANDOMIZATION SEED: {randomSeed}

CONTEXT:
{context}

INSTRUCTIONS:
- Generate exactly {numberOfQuestions} multiple-choice questions.
- Questions must be based ONLY on the provided context.
- IMPORTANT: Be highly creative and pick a random, diverse set of facts scattered throughout the context. Do not just pick the most obvious facts or the ones at the beginning.
- The difficulty of the questions should be '{difficulty}'.
- Each question must have exactly 4 options.
- Ensure the correctAnswer exactly matches one of the options.
- Do NOT output markdown code blocks (e.g. \`\`\`json). Just output raw JSON.

{format_instructions}
`);

    // 6. Build the LCEL Chain
    const chain = RunnableSequence.from([
      prompt,
      llm,
      parser
    ]);

    // 7. Invoke the chain
    const result = await chain.invoke({
      subject,
      topic,
      difficulty,
      numberOfQuestions: numberOfQuestions.toString(),
      context: contextText,
      randomSeed: Math.random().toString(36).substring(2, 15), // Forces a different prompt string every time
      format_instructions: parser.getFormatInstructions()
    });

    return result;
  }
}

module.exports = QuizService;
