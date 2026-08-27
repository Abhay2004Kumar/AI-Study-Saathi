const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { z } = require('zod');
const config = require('../../config/env');

// Depth is fixed at Subject -> Topic -> Subtopic, matching the Exam schema.
const subtopicSchema = z.object({
  name: z.string().describe('A short, specific subtopic name'),
});

const topicSchema = z.object({
  name: z.string().describe('A topic name'),
  subtopics: z
    .array(subtopicSchema)
    .describe('Subtopics under this topic; an empty array if none are explicit in the source text'),
});

const subjectSchema = z.object({
  name: z.string().describe('A subject / unit name'),
  topics: z.array(topicSchema).describe('Topics under this subject'),
});

const syllabusSchema = z.object({
  subjects: z.array(subjectSchema).describe('The full syllabus broken into subjects, topics, and subtopics'),
});

// Prompts are truncated to this many characters to bound cost/latency on a
// single extraction call; long documents should go through the Phase 3
// chunked ingestion pipeline instead.
const MAX_INPUT_CHARS = 20000;

class SyllabusExtractionService {
  /**
   * Turns raw syllabus text into a suggested Subject -> Topic -> Subtopic
   * tree. This is a PREVIEW only — nothing is persisted here. The caller is
   * expected to let the user review/edit the result and then submit it
   * through the exam create or PUT /:id/syllabus endpoints, which validate
   * and store it.
   *
   * @param {string} rawText
   * @returns {Promise<{subjects: Array}>}
   */
  static async extractFromText(rawText) {
    if (!rawText || !rawText.trim()) {
      throw new Error('No syllabus text provided');
    }

    const parser = StructuredOutputParser.fromZodSchema(syllabusSchema);
    const llm = new ChatGoogleGenerativeAI({
      apiKey: config.gemini.apiKey,
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
    });

    const prompt = PromptTemplate.fromTemplate(`
You are helping a student organize an exam syllabus into a structured outline.

RAW SYLLABUS TEXT:
{rawText}

INSTRUCTIONS:
- Break the content into Subjects, each containing Topics, each optionally containing Subtopics.
- Preserve the original wording of names where reasonable; don't invent content the text doesn't imply.
- If the text is flat with no clear subject grouping, create a single subject capturing the overall exam/unit name and list topics under it.
- If a topic has no meaningfully distinct subtopics, return an empty subtopics array for it rather than inventing one.
- Do NOT output markdown code blocks (e.g. \`\`\`json). Just output raw JSON.

{format_instructions}
`);

    const chain = RunnableSequence.from([prompt, llm, parser]);

    try {
      return await chain.invoke({
        rawText: rawText.slice(0, MAX_INPUT_CHARS),
        format_instructions: parser.getFormatInstructions(),
      });
    } catch (error) {
      console.error('Syllabus extraction failed:', error);
      throw new Error('Failed to extract a syllabus structure from the provided text');
    }
  }
}

module.exports = SyllabusExtractionService;
