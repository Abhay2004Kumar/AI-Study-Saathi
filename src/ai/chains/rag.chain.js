const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { z } = require('zod');
const { ragPromptTemplate } = require('../prompts/rag.prompt');

// Structured output — not a bare string — is what lets the service layer
// verify the model's claims instead of trusting them. `usedSourceIds` is
// cross-checked against what was actually retrieved before anything is
// reported to the user as a "source"; `foundInMaterials` is what forces the
// service to blank out sources when the model answered from general
// knowledge rather than the student's own resources.
const ragAnswerSchema = z.object({
  answer: z.string().describe("The answer to the student's question"),
  foundInMaterials: z
    .boolean()
    .describe('True only if the numbered sources actually contained information that answers the question'),
  usedSourceIds: z
    .array(z.string())
    .describe('The source labels (e.g. "S1", "S3") actually used to answer — empty if none were relevant or used'),
});

/**
 * Formats retrieved chunks into a numbered, labeled block the model can cite
 * by label (S1, S2, ...) rather than by title, since multiple chunks can
 * share the same document title.
 */
function formatSourcesForPrompt(docs) {
  if (!docs || docs.length === 0) {
    return "No sources were found in the student's materials.";
  }
  return docs
    .map((doc, i) => {
      const pageInfo = doc.metadata.page ? `, page ${doc.metadata.page}` : '';
      return `[S${i + 1}] ${doc.metadata.title}${pageInfo}\n${doc.pageContent}`;
    })
    .join('\n\n');
}

/**
 * Builds the RAG answer-generation chain. Retrieval happens outside this
 * chain (in the caller) so the same retrieved docs can be reused both to
 * build the prompt context and to validate the model's source claims
 * afterward, instead of retrieving twice.
 *
 * @param {object} llm - an instantiated chat model (e.g. ChatGoogleGenerativeAI)
 */
async function buildRagChain(llm) {
  const parser = StructuredOutputParser.fromZodSchema(ragAnswerSchema);
  const prompt = await ragPromptTemplate.partial({ format_instructions: parser.getFormatInstructions() });
  return RunnableSequence.from([prompt, llm, parser]);
}

module.exports = { buildRagChain, formatSourcesForPrompt, ragAnswerSchema };
