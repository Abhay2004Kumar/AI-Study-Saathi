const { createReactAgent } = require('@langchain/langgraph/prebuilt');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const prisma = require('../../config/db');
const config = require('../../config/env');
const RAGService = require('../services/rag.service');
const MasteryService = require('../../services/mastery.service');
const StudyPlanService = require('../../services/studyPlan.service');
const PyqIntelligenceService = require('../services/pyqIntelligence.service');
const FlashcardReviewService = require('../../services/flashcardReview.service');

const SYSTEM_PROMPT = `You are the AI Study Assistant inside a student's exam-prep app, helping them prepare for one specific exam.

You have tools that read the student's OWN real data — their quiz performance, their study plan, how often topics have appeared in past papers they uploaded, and their own uploaded notes. ALWAYS use a tool instead of guessing when the student asks about their progress, their plan, a topic's importance, or anything that should come from their materials. Never invent facts, scores, or study-plan details — if a tool says there's no data, tell the student that plainly (e.g. suggest generating a plan, taking a quiz, or uploading notes) instead of making something up.

For questions about a concept or fact from their course material, use search_study_material rather than answering from your own general knowledge — this app is about THEIR materials, not general trivia. If that tool reports nothing relevant was found, say so honestly.

Keep answers concise and encouraging, and ground every claim about the student's own performance or plan in what a tool actually returned.

Your reply is displayed as plain text with no math or markdown rendering. NEVER use LaTeX syntax (no $...$, \\(...\\), \\rightarrow, \\ge, etc.) and never wrap terms in markdown (no **bold**, no backticks). Write formulas and notation in plain words or ordinary keyboard/unicode symbols instead — e.g. "X -> A" or "X → A", ">=", "<=", "!=".`;

// Every tool is built inside this factory, closed over one (userId, examId)
// pair — never parameters the model can supply. A tool argument like a
// topic *name* still gets resolved against `WHERE ... AND subject.examId =
// examId` server-side, so even a hallucinated or cross-exam name can only
// ever resolve to something this user already owns, never leak another
// user's or another exam's data.
function buildTools(userId, examId) {
  const searchStudyMaterial = tool(
    async ({ question }) => {
      const result = await RAGService.askQuestion(userId, question, { examId });
      if (!result.foundInMaterials) {
        return 'Nothing relevant was found in the materials uploaded for this exam.';
      }
      return JSON.stringify({ answer: result.answer, sources: result.sources });
    },
    {
      name: 'search_study_material',
      description:
        "Answers a question strictly from the student's own uploaded study materials for this exam. Use this whenever the student asks to be taught, reminded, or quizzed about a concept or fact.",
      schema: z.object({ question: z.string().describe("The question to answer from the student's materials") }),
    }
  );

  const getMasteryOverview = tool(
    async () => {
      const data = await MasteryService.getExamMastery(userId, examId);
      if (data.length === 0) return 'This exam has no syllabus topics yet.';
      return JSON.stringify(
        data.map((d) => ({
          topic: d.topic.name,
          level: d.mastery.level,
          accuracy: d.mastery.accuracy,
          attempts: d.mastery.attemptCount,
        }))
      );
    },
    {
      name: 'get_mastery_overview',
      description:
        "Returns the student's own deterministically-computed mastery level (NOT_STARTED, WEAK, DEVELOPING, or STRONG) for every topic in this exam, based on their actual quiz history. Use this for any question about strengths, weaknesses, progress, or readiness.",
      schema: z.object({}),
    }
  );

  const getTopicPyqImportance = tool(
    async ({ topicName }) => {
      const topic = await prisma.topic.findFirst({
        where: { name: { equals: topicName, mode: 'insensitive' }, subject: { examId } },
        select: { id: true, name: true },
      });
      if (!topic) return `No topic named "${topicName}" was found in this exam's syllabus.`;

      const frequency = await PyqIntelligenceService.getTopicFrequency(topic.id);
      return JSON.stringify({ topic: topic.name, ...frequency });
    },
    {
      name: 'get_topic_pyq_importance',
      description:
        "Returns how often a named topic has appeared in the student's uploaded past-year question papers (frequency level and years seen). Use this for questions like 'how important is X' or 'does X come up often'.",
      schema: z.object({ topicName: z.string().describe('The syllabus topic name to check') }),
    }
  );

  const getTodaysStudyPlan = tool(
    async () => {
      const plan = await StudyPlanService.getActivePlan(userId, examId);
      if (!plan) return 'No study plan has been generated for this exam yet.';

      const todayKey = new Date().toDateString();
      const today = plan.sessions.filter((s) => new Date(s.date).toDateString() === todayKey);
      if (today.length === 0) return "Nothing is scheduled for today in the student's study plan.";

      return JSON.stringify(
        today.map((s) => ({
          topic: s.topic?.name,
          minutes: s.durationMinutes,
          reason: s.reason,
          completed: s.completed,
        }))
      );
    },
    {
      name: 'get_todays_study_plan',
      description:
        "Returns today's sessions from the student's adaptive study plan for this exam — which topics, for how long, and why. Use this for 'what should I study today' or 'what's on my plan'.",
      schema: z.object({}),
    }
  );

  const getDueFlashcardCount = tool(
    async () => {
      const due = await FlashcardReviewService.getDueCards(userId, examId, { limit: 200 });
      return `${due.length} flashcard(s) are due for revision right now.`;
    },
    {
      name: 'get_due_flashcard_count',
      description: "Returns how many of the student's flashcards are due for spaced-repetition review right now.",
      schema: z.object({}),
    }
  );

  return [searchStudyMaterial, getMasteryOverview, getTopicPyqImportance, getTodaysStudyPlan, getDueFlashcardCount];
}

function buildStudyAssistantAgent(userId, examId) {
  const llm = new ChatGoogleGenerativeAI({
    apiKey: config.gemini.apiKey,
    model: 'gemini-3.5-flash-lite',
    temperature: 0.3,
  });

  return createReactAgent({
    llm,
    tools: buildTools(userId, examId),
    prompt: SYSTEM_PROMPT,
  });
}

module.exports = { buildStudyAssistantAgent, buildTools };
