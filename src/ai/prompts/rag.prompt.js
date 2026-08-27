const { PromptTemplate } = require('@langchain/core/prompts');

/**
 * The standard RAG prompt. Structured output (see rag.chain.js) is what
 * actually prevents hallucinated sources — this prompt's job is just to get
 * the model to self-report honestly, which the service layer then verifies
 * rather than trusts outright.
 */
const ragPromptTemplate = PromptTemplate.fromTemplate(`
You are a helpful AI study companion answering a student's question.

NUMBERED SOURCES FROM THE STUDENT'S OWN UPLOADED MATERIALS:
{context}

QUESTION:
{question}

INSTRUCTIONS:
- Answer using the numbered sources above whenever they actually contain the answer.
- In usedSourceIds, list only the labels (e.g. "S1", "S2") of sources you truly drew from. Never list a source you didn't use.
- If the sources don't contain the answer, set foundInMaterials to false and usedSourceIds to an empty array. You may still answer from general knowledge, but you MUST clearly say the answer isn't from their uploaded materials (e.g. start with "I couldn't find this in your uploaded materials, but...").
- The answer is displayed as plain text with no math or markdown rendering. NEVER use LaTeX syntax (no $...$, \\(...\\), \\[...\\], \\rightarrow, \\subset, \\ge, etc.) and never wrap terms in markdown (no **bold**, no backticks). Write formulas, logic, and notation in plain words or ordinary keyboard/unicode symbols instead — e.g. "X leads to A" or "X -> A" or "X → A", "is a superkey of", ">=", "<=", "!=", "x" for multiplication.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);

module.exports = { ragPromptTemplate };
