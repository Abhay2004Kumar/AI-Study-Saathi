// A row a background job is writing to can disappear mid-flight (e.g. the
// user deleted the parent document while a fire-and-forget job was still
// running). That's not a real failure — there's just nothing left to write
// to — so callers can check this and bail out quietly instead of treating it
// as an error.
//
// P2025 = "record to update not found" (Prisma write), P2003 = FK constraint
// failed on a Prisma write. A failed $executeRaw instead comes back as a
// generic P2010 wrapping a driver-adapter error (this project uses
// @prisma/adapter-pg) — the FK violation shows up as
// error.meta.driverAdapterError.message, not as a top-level code, because
// DriverAdapterError (@prisma/adapter-pg) prints as `[DriverAdapterError: <kind>]`,
// i.e. the mapped error kind ends up as its `.message`.
const RECORD_GONE_CODES = new Set(['P2025', 'P2003']);

function isRecordGoneError(error) {
  return (
    RECORD_GONE_CODES.has(error.code) ||
    error.meta?.driverAdapterError?.message === 'ForeignKeyConstraintViolation'
  );
}

module.exports = { isRecordGoneError };
