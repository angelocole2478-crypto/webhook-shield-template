import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { closeInfra } from '../src/infra.js';

test('health endpoint is public and healthy', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  await app.close();
});

test('webhook without secret is rejected', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'POST', url: '/webhooks', payload: { type: 'demo' } });
  assert.equal(response.statusCode, 401);
  await app.close();
});

after(async () => { await closeInfra(); });
