import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === 'test') {
    const testDefaults: Record<string, string> = {
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      DELIVERY_URL: 'http://127.0.0.1:3999',
      INGEST_SECRET: 'test-ingest-secret'
    };
    if (testDefaults[name]) return testDefaults[name];
  }
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  deliveryUrl: required('DELIVERY_URL'),
  ingestSecret: required('INGEST_SECRET'),
  monitorSecret: process.env.MONITOR_SECRET ?? process.env.INGEST_SECRET,
  maxAttempts: Math.max(1, Number(process.env.MAX_ATTEMPTS ?? 3)),
  retentionDays: Math.max(1, Number(process.env.RETENTION_DAYS ?? 14))
};
