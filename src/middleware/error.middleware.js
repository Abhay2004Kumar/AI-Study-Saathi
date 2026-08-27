// A Gemini free-tier rate/quota limit that survived withRetry's own bounded
// retries. Every AI-invoking endpoint (RAG, tutoring, ingestion, quizzes,
// ...) can hit this, so it's handled once here rather than duplicated in
// each controller's catch block — surfaced as a clean, actionable 503
// instead of a raw provider error dump.
function isUnretriedRateLimitError(err) {
  return err.status === 429 || /quota|rate.?limit/i.test(err.message || '');
}

const errorHandler = (err, req, res, next) => {
  if (isUnretriedRateLimitError(err)) {
    return res.status(503).json({
      success: false,
      message: 'The AI service is temporarily at its usage limit. Please try again in a few minutes.',
    });
  }

  // Service-thrown AppErrors carry their own status; older controllers still
  // set res.status() before throwing, which this falls back to.
  const statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);

  res.status(statusCode).json({
    success: false,
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

const notFoundHandler = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

module.exports = {
  errorHandler,
  notFoundHandler,
};
