const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage } = require('@langchain/core/messages');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { z } = require('zod');
const fs = require('fs');
const config = require('../../config/env');
const { withRetry } = require('../utils/withRetry');

// Gemini reads images natively — no separate OCR library needed, same
// "extend the existing AI stack" call as everywhere else in this app.
// Structured output is still the floor here, not a guarantee: `extractedText`
// is Gemini's own transcription of the image, exactly as fallible as any
// other AI-generated text, so it flows into the same pipeline (chunking,
// topic mapping with a closed catalog, confidence-threshold review) that
// already never trusts a document's extracted text as ground truth beyond
// what's literally there.
const ocrSchema = z.object({
  hasReadableText: z.boolean().describe('Whether the image contains any legible text at all'),
  extractedText: z
    .string()
    .describe(
      'Every piece of legible text in the image, transcribed verbatim (handwritten or printed). Empty string if hasReadableText is false.'
    ),
});

const llm = new ChatGoogleGenerativeAI({
  apiKey: config.gemini.apiKey,
  model: 'gemini-3.5-flash-lite',
  temperature: 0,
});

class OcrService {
  /**
   * Transcribes the legible text out of an image file via Gemini's vision
   * input, so a photographed page of notes/PYQs joins the same
   * classify/extract/chunk/embed pipeline a typed document already goes
   * through.
   *
   * @param {string} filePath
   * @param {string} mimeType - e.g. 'image/jpeg'
   * @returns {Promise<{hasReadableText: boolean, extractedText: string}>}
   */
  static async extractText(filePath, mimeType) {
    const parser = StructuredOutputParser.fromZodSchema(ocrSchema);
    const base64 = fs.readFileSync(filePath).toString('base64');

    const message = new HumanMessage({
      content: [
        {
          type: 'text',
          text: `Transcribe every piece of legible text in this image exactly as written — handwritten or printed notes, headings, bullet points, questions, diagram labels, anything readable. Preserve structure (headings, lists) where it's clear, but write in plain text only: no LaTeX (no $...$, \\rightarrow, \\ge, etc.) and no markdown (no **bold**, no backticks) — write formulas and notation in plain words or ordinary keyboard symbols instead, e.g. "X -> A". If nothing in the image is legible, set hasReadableText to false and extractedText to an empty string.\n\n${parser.getFormatInstructions()}`,
        },
        {
          type: 'image_url',
          image_url: `data:${mimeType};base64,${base64}`,
        },
      ],
    });

    const response = await withRetry(() => llm.invoke([message]));
    return parser.parse(response.content);
  }
}

module.exports = OcrService;
