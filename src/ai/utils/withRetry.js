// Bounded retry for two known-transient LLM failure modes:
//  - Gemini rate-limit (429) errors, where a fresh attempt after the API's
//    own suggested delay often succeeds once the per-minute window rolls over.
//  - LangChain OutputParserException (lc_error_code OUTPUT_PARSING_FAILURE),
//    where the model returned malformed JSON — generation is non-deterministic
//    even at temperature 0, so a same-request retry frequently gets valid
//    output the second time.
// Both are capped so a single call can't stall a caller indefinitely —
// callers that need the result (like ingestion) already have their own
// graceful fallback if this still fails after retrying.
async function withRetry(fn, { retries = 1, defaultDelayMs = 5000, maxDelayMs = 15000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === retries) throw error;

      const delay = Math.min(extractRetryDelayMs(error) ?? defaultDelayMs * (attempt + 1), maxDelayMs);
      console.warn(`Retrying transient LLM error in ${delay}ms (attempt ${attempt + 1}/${retries}): ${error.message?.slice(0, 120)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function isRetryableError(error) {
  return isRateLimitError(error) || error?.lc_error_code === 'OUTPUT_PARSING_FAILURE';
}

function isRateLimitError(error) {
  return error?.status === 429 || /429|rate.?limit|quota/i.test(error?.message || '');
}

function extractRetryDelayMs(error) {
  const match = /retry in ([\d.]+)s/i.exec(error?.message || '');
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

module.exports = { withRetry };
