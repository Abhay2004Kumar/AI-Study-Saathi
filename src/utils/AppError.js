// Lets a service layer carry an HTTP status with an error without importing
// `res`. error.middleware reads `err.statusCode` first, falling back to
// whatever the older res.status()-then-throw controllers already set.
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

module.exports = AppError;
