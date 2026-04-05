// Set required env vars before any module is imported
// Test-only env vars — never used in production
process.env.ENCRYPTION_KEY = 'a'.repeat(64)  // 64 hex chars = 32 bytes, test only
process.env.SESSION_SECRET = 'test-session-secret'
process.env.RECOVERY_SECRET = 'test-recovery-secret'
