const { StateGraph, END } = require('@langchain/langgraph');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { z } = require('zod');
const config = require('../../config/env');
const SyllabusExtractionService = require('../services/syllabusExtraction.service');
const { withRetry } = require('../utils/withRetry');

// Extraction nodes get more of the document than classification does — they
// need enough material to actually find topics/questions, not just a taste.
const CLASSIFY_INPUT_CHARS = 6000;
const EXTRACT_INPUT_CHARS = 20000;

const llm = new ChatGoogleGenerativeAI({
  apiKey: config.gemini.apiKey,
  model: 'gemini-3.5-flash',
  temperature: 0,
});

// -------------------------------------------------------------------
// Schemas — the whole point of structured output here is to never trust
// the LLM's classification/extraction without validating its shape first.
// -------------------------------------------------------------------
const classificationSchema = z.object({
  resourceType: z
    .enum(['SYLLABUS', 'NOTES', 'PYQ', 'GENERAL'])
    .describe('SYLLABUS: a syllabus/curriculum outline. NOTES: study notes/explanatory material. PYQ: exam/practice questions. GENERAL: anything else.'),
  confidence: z.number().min(0).max(1).describe('How confident you are in this classification, from 0 to 1'),
  summary: z.string().max(300).describe('A one or two sentence summary of what this document contains'),
});

const topicsSchema = z.object({
  topics: z
    .array(
      z.object({
        name: z.string().describe('A concise topic or concept name'),
        description: z.string().optional().describe('One short sentence describing what this topic covers here'),
      })
    )
    .describe('Distinct topics or concepts actually covered in this material'),
});

const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.string()).optional().describe('Multiple choice options, only if present in the source'),
        correctAnswer: z.string().optional().describe('The correct answer, only if explicitly indicated in the source'),
        year: z.string().optional().describe('The exam year this question is from, only if explicitly stated'),
      })
    )
    .describe('Questions found in this document — an empty array if none are clearly present'),
});

// -------------------------------------------------------------------
// NODE: Classify the resource type
// -------------------------------------------------------------------
const classifyNode = async (state) => {
  const parser = StructuredOutputParser.fromZodSchema(classificationSchema);
  const prompt = PromptTemplate.fromTemplate(`
You are triaging a student's uploaded study material.

CONTENT SAMPLE:
{text}

INSTRUCTIONS:
- Classify this content as SYLLABUS, NOTES, PYQ (previous-year/practice questions), or GENERAL.
- Base the classification only on what's actually in the sample.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);
  const chain = RunnableSequence.from([prompt, llm, parser]);

  try {
    const result = await withRetry(() =>
      chain.invoke({
        text: state.rawText.slice(0, CLASSIFY_INPUT_CHARS),
        format_instructions: parser.getFormatInstructions(),
      })
    );
    return { resourceType: result.resourceType, confidence: result.confidence, summary: result.summary };
  } catch (error) {
    console.error('Ingestion classification failed, falling back to the user-selected category:', error);
    // Never let a bad/unparseable LLM response crash ingestion — fall back
    // to what the user already told us at upload time, with zero confidence
    // so callers know this wasn't actually verified.
    return { resourceType: state.userCategory, confidence: 0, summary: '' };
  }
};

// -------------------------------------------------------------------
// NODE: Extract candidate topics (NOTES)
// -------------------------------------------------------------------
const extractTopicsNode = async (state) => {
  const parser = StructuredOutputParser.fromZodSchema(topicsSchema);
  const prompt = PromptTemplate.fromTemplate(`
You are analyzing a student's study notes to identify the distinct topics covered.

CONTENT:
{text}

INSTRUCTIONS:
- List the distinct topics or concepts actually covered in this content.
- Keep names short and specific (e.g. "Binary Search Trees", not "Data Structures").
- Do not invent topics that aren't actually present in the content.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);
  const chain = RunnableSequence.from([prompt, llm, parser]);

  try {
    const result = await withRetry(() =>
      chain.invoke({
        text: state.rawText.slice(0, EXTRACT_INPUT_CHARS),
        format_instructions: parser.getFormatInstructions(),
      })
    );
    return { topics: result.topics };
  } catch (error) {
    console.error('Ingestion topic extraction failed:', error);
    return { topics: [] };
  }
};

// -------------------------------------------------------------------
// NODE: Extract syllabus structure (SYLLABUS) — reuses the Phase 1 extractor
// -------------------------------------------------------------------
const extractSyllabusNode = async (state) => {
  try {
    const result = await SyllabusExtractionService.extractFromText(state.rawText);
    return { topics: result }; // { subjects: [...] }
  } catch (error) {
    console.error('Ingestion syllabus structure extraction failed:', error);
    return { topics: null };
  }
};

// -------------------------------------------------------------------
// NODE: Extract questions (PYQ)
// -------------------------------------------------------------------
const extractQuestionsNode = async (state) => {
  const parser = StructuredOutputParser.fromZodSchema(questionsSchema);
  const prompt = PromptTemplate.fromTemplate(`
You are extracting exam questions from a previous-year question paper.

CONTENT:
{text}

INSTRUCTIONS:
- Extract each distinct question found in the content.
- Include options and the correct answer ONLY if explicitly present in the text — never guess an answer.
- Include the year ONLY if it is explicitly stated in the text.
- If no clear questions are present, return an empty array — do not invent questions.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);
  const chain = RunnableSequence.from([prompt, llm, parser]);

  try {
    const result = await withRetry(() =>
      chain.invoke({
        text: state.rawText.slice(0, EXTRACT_INPUT_CHARS),
        format_instructions: parser.getFormatInstructions(),
      })
    );
    return { questions: result.questions };
  } catch (error) {
    console.error('Ingestion question extraction failed:', error);
    return { questions: [] };
  }
};

// -------------------------------------------------------------------
// BUILD GRAPH
// -------------------------------------------------------------------
const buildIngestionGraph = () => {
  const graph = new StateGraph({
    channels: {
      documentId: { value: (a, b) => b ?? a, default: () => '' },
      userCategory: { value: (a, b) => b ?? a, default: () => 'GENERAL' },
      rawText: { value: (a, b) => b ?? a, default: () => '' },
      resourceType: { value: (a, b) => b ?? a, default: () => 'GENERAL' },
      confidence: { value: (a, b) => b ?? a, default: () => 0 },
      summary: { value: (a, b) => b ?? a, default: () => '' },
      topics: { value: (a, b) => b ?? a, default: () => null },
      questions: { value: (a, b) => b ?? a, default: () => null },
    },
  });

  graph.addNode('classify', classifyNode);
  graph.addNode('extractTopics', extractTopicsNode);
  graph.addNode('extractSyllabus', extractSyllabusNode);
  graph.addNode('extractQuestions', extractQuestionsNode);

  graph.setEntryPoint('classify');

  graph.addConditionalEdges('classify', (state) => state.resourceType, {
    NOTES: 'extractTopics',
    SYLLABUS: 'extractSyllabus',
    PYQ: 'extractQuestions',
    GENERAL: END,
  });

  graph.addEdge('extractTopics', END);
  graph.addEdge('extractSyllabus', END);
  graph.addEdge('extractQuestions', END);

  return graph.compile();
};

module.exports = { buildIngestionGraph };
