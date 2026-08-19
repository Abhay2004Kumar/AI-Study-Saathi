const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { z } = require('zod');
const { RunnableSequence } = require('@langchain/core/runnables');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const config = require('../../config/env');

// 1. Define the Zod schema for a deck of flashcards
const flashcardSchema = z.object({
  subject: z.string().describe("The subject of the flashcard deck"),
  topic: z.string().describe("The specific topic covered in the flashcard deck"),
  flashcards: z.array(
    z.object({
      front: z.string().describe("The question or term on the front of the flashcard"),
      back: z.string().describe("The answer or definition on the back of the flashcard"),
      hint: z.string().optional().describe("An optional hint to help remember the answer"),
      source: z.string().optional().describe("The document title this card was sourced from")
    })
  ).describe("The array of flashcard objects in this deck")
});

class FlashcardService {
  /**
   * Generates a structured flashcard deck from a user's documents using RAG.
   *
   * @param {string} userId - The user's ID to scope the retrieval.
   * @param {string} subject - The subject (e.g., "Operating Systems").
   * @param {string} topic - The topic (e.g., "Process Scheduling").
   * @param {number} numberOfCards - How many flashcards to generate.
   * @returns {Promise<Object>} The generated flashcard deck.
   */
  static async generateFlashcards(userId, subject, topic, numberOfCards = 10) {
    // 2. Initialize the StructuredOutputParser with our flashcard schema
    const parser = StructuredOutputParser.fromZodSchema(flashcardSchema);

    // 3. Retrieve relevant context from the user's documents
    const searchQuery = `${subject} ${topic} key concepts, definitions, and terms`;
    const retriever = new PGVectorRetriever({ userId, topK: 10 });
    const docs = await retriever.invoke(searchQuery);

    const contextText = docs
      .map(doc => `Source: ${doc.metadata.title || 'Unknown'}\nContent: ${doc.pageContent}`)
      .join('\n\n');

    // 4. Initialize the LLM
    const llm = new ChatGoogleGenerativeAI({
      model: "gemini-3.5-flash-lite",
      temperature: 0.2, // Slightly higher for variety in wording
      apiKey: config.gemini.apiKey,
    });

    // 5. Create the prompt template
    const prompt = PromptTemplate.fromTemplate(`
You are an expert educational AI tutor specializing in creating concise and effective flashcards.
Your task is to generate a flashcard deck based ONLY on the provided context.

SUBJECT: {subject}
TOPIC: {topic}
NUMBER OF CARDS: {numberOfCards}

CONTEXT:
{context}

INSTRUCTIONS:
- Generate exactly {numberOfCards} flashcards.
- Each flashcard MUST be directly derived from the provided context.
- The "front" should be a clear, concise question or key term.
- The "back" should be the answer or definition. Keep it brief but complete.
- Optionally provide a "hint" that gives a nudge without revealing the answer.
- Include the "source" field with the document title the card was taken from.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);

    // 6. Build and invoke the LCEL chain
    const chain = RunnableSequence.from([prompt, llm, parser]);

    const result = await chain.invoke({
      subject,
      topic,
      numberOfCards: numberOfCards.toString(),
      context: contextText,
      format_instructions: parser.getFormatInstructions(),
    });

    return result;
  }
}

module.exports = FlashcardService;
