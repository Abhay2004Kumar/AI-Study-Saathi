const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { z } = require('zod');
const { RunnableSequence } = require('@langchain/core/runnables');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const { withRetry } = require('../utils/withRetry');
const prisma = require('../../config/db');
const config = require('../../config/env');

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 15;
const RETRIEVAL_TOP_K = 12;

const quizSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe('The text of the multiple choice question'),
      options: z.array(z.string()).describe('An array of exactly 4 possible options'),
      correctAnswer: z.string().describe('The exact text of the correct option'),
      explanation: z.string().describe('A short explanation of why this answer is correct'),
    })
  ).describe('The array of quiz questions'),
});

class QuizService {
  /**
   * Generates a topic-scoped, structured multiple-choice quiz and persists
   * it. Unlike the free-text draft this replaces, generation is always tied
   * to a real syllabus Topic (never an AI-guessed or free-typed name) so the
   * resulting attempts can feed Phase 8's mastery engine directly.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.examId
   * @param {string} params.subjectId
   * @param {string} params.topicId
   * @param {string} params.topicName
   * @param {string} [params.subtopicId]
   * @param {string} [params.subtopicName]
   * @param {number} [params.numberOfQuestions]
   * @param {string} [params.difficulty] - easy, medium, hard
   * @returns {Promise<Object>} the persisted Quiz row, including questions (with answers)
   */
  static async generateQuiz({
    userId,
    examId,
    subjectId,
    topicId,
    topicName,
    subtopicId = null,
    subtopicName = null,
    numberOfQuestions = 5,
    difficulty = 'medium',
  }) {
    const count = Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, Number(numberOfQuestions) || 5));

    // Prefer resources already mapped to this topic (Phase 5) so the quiz is
    // built from material the student actually confirmed covers it; only
    // fall back to exam-wide retrieval when nothing has been mapped yet.
    const mappings = await prisma.resourceTopicMapping.findMany({
      where: {
        topicId,
        subtopicId: subtopicId || undefined,
        status: { not: 'REJECTED' },
        document: { userId },
      },
      select: { documentId: true },
    });
    const mappedDocumentIds = [...new Set(mappings.map((m) => m.documentId))];

    const retriever = new PGVectorRetriever({
      userId,
      examId,
      topK: RETRIEVAL_TOP_K,
      documentIds: mappedDocumentIds.length > 0 ? mappedDocumentIds : undefined,
    });
    const searchQuery = subtopicName ? `${topicName} ${subtopicName}` : topicName;
    const docs = await retriever.invoke(searchQuery);

    if (docs.length === 0) {
      return null; // nothing to generate from — caller turns this into a 400
    }

    const contextText = docs
      .map((doc, i) => `Source S${i + 1} (${doc.metadata.title || 'Unknown'}):\n${doc.pageContent}`)
      .join('\n\n');
    const sourceDocumentIds = [...new Set(docs.map((d) => d.metadata.documentId))];

    const parser = StructuredOutputParser.fromZodSchema(quizSchema);
    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.5-flash-lite',
      temperature: 0.8, // diverse/random question selection across the material
      apiKey: config.gemini.apiKey,
    });

    const prompt = PromptTemplate.fromTemplate(`
You are an expert exam-preparation AI. Generate a multiple-choice quiz strictly from the provided study material.

TOPIC: {topic}
DIFFICULTY: {difficulty}
NUMBER OF QUESTIONS: {numberOfQuestions}
RANDOMIZATION SEED: {randomSeed}

STUDY MATERIAL:
{context}

INSTRUCTIONS:
- Generate exactly {numberOfQuestions} multiple-choice questions.
- Base every question ONLY on the study material above — never invent facts outside it.
- Be creative and pick a diverse set of facts scattered throughout the material, not just the first ones.
- The difficulty of the questions should be '{difficulty}'.
- Each question must have exactly 4 options.
- Ensure correctAnswer exactly matches one of the options (character-for-character).
- Every field is displayed as plain text with no math or markdown rendering. NEVER use LaTeX syntax (no $...$, \\(...\\), \\rightarrow, \\ge, etc.) and never wrap terms in markdown (no **bold**, no backticks). Write formulas and notation in plain words or ordinary keyboard/unicode symbols instead — e.g. "X -> A" or "X → A", ">=", "<=", "!=".
- Do NOT output markdown code blocks (e.g. \`\`\`json). Just output raw JSON.

{format_instructions}
`);

    const chain = RunnableSequence.from([prompt, llm, parser]);
    const result = await withRetry(() =>
      chain.invoke({
        topic: subtopicName ? `${topicName} — ${subtopicName}` : topicName,
        difficulty,
        numberOfQuestions: count.toString(),
        context: contextText,
        randomSeed: Math.random().toString(36).substring(2, 15),
        format_instructions: parser.getFormatInstructions(),
      })
    );

    const questions = (result.questions || []).filter(
      (q) => q.question && Array.isArray(q.options) && q.options.length === 4 && q.options.includes(q.correctAnswer)
    );
    if (questions.length === 0) return null;

    const quiz = await prisma.quiz.create({
      data: {
        userId,
        subjectId,
        topicId,
        subtopicId,
        title: subtopicName ? `${topicName} — ${subtopicName}` : topicName,
        difficulty,
        sourceDocumentIds,
        questions: {
          create: questions.map((q) => ({
            question: q.question,
            options: q.options,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation || null,
            difficulty,
          })),
        },
      },
      include: { questions: true },
    });

    return quiz;
  }

  /**
   * Deterministically grades a submitted attempt: exact-match every
   * selected answer against the stored correctAnswer. No AI involved —
   * scoring an MCQ against a known-correct string never needs a model.
   */
  static async submitAttempt(quizId, userId, answers) {
    const quiz = await prisma.quiz.findFirst({
      where: { id: quizId, userId },
      include: { questions: true },
    });
    if (!quiz) return null;

    const answerByQuestionId = new Map(
      (Array.isArray(answers) ? answers : [])
        .filter((a) => a && a.questionId)
        .map((a) => [a.questionId, a.selectedAnswer ?? null])
    );

    const graded = quiz.questions.map((q) => {
      const selectedAnswer = answerByQuestionId.get(q.id) ?? null;
      return {
        questionId: q.id,
        selectedAnswer,
        isCorrect: selectedAnswer !== null && selectedAnswer === q.correctAnswer,
      };
    });

    const correctCount = graded.filter((g) => g.isCorrect).length;
    const totalQuestions = quiz.questions.length;
    const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 10000) / 100 : 0;

    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId,
        score,
        totalQuestions,
        correctCount,
        completedAt: new Date(),
        answers: { create: graded },
      },
      include: { answers: true },
    });

    return { attempt, quiz };
  }
}

module.exports = QuizService;
