const DocumentProcessingService = require('./src/ai/services/documentProcessing.service');

// Runs after every test file's own afterAll. Document uploads/retries kick
// off real, unawaited background processing (embeddings + AI classification
// calls) — if a file's own cleanup disconnects Prisma while one is still in
// flight, the orphaned promise keeps running against a torn-down client and
// can throw confusing low-level errors later, in whatever file happens to be
// running by the time it settles. Draining here, globally, closes that gap
// for every test file at once instead of requiring each one to remember to
// do it individually.
afterAll(async () => {
  await DocumentProcessingService.waitForAllBackgroundProcessing();
});
