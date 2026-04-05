// Set required env vars before any module is imported
// Test-only env vars — never used in production
process.env.ENCRYPTION_KEY = 'a'.repeat(64)   // 64 hex chars = 32 bytes, test only
process.env.SESSION_SECRET = 'b'.repeat(64)   // must be valid hex (used as Buffer.from(..., 'hex'))
process.env.RECOVERY_SECRET = 'c'.repeat(64)  // must be valid hex (used as Buffer.from(..., 'hex'))
