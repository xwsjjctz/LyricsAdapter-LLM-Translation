import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettings } from '../src/settings.ts';

function context(format, secret) {
  return {
    configuration: { get: key => ({
      'api-format': format, endpoint: '', model: 'test-model', 'api-key': '',
      style: 'natural', instructions: '', 'timeout-seconds': 90,
      'json-mode': true, 'use-cache': true,
    })[key] },
    secrets: { get: key => {
      assert.equal(key, 'api-key');
      return secret;
    } },
  };
}

for (const format of ['openai', 'anthropic']) {
  test(`${format} reads the saved key from secrets despite empty configuration`, () => {
    assert.equal(readSettings(context(format, '  test-key  ')).apiKey, 'test-key');
  });
}

test('a local model may have no saved key', () => {
  assert.equal(readSettings(context('openai', undefined)).apiKey, '');
});

test('saved key changes apply to the next request', () => {
  const ctx = context('openai', 'first');
  assert.equal(readSettings(ctx).apiKey, 'first');
  ctx.secrets.get = () => 'second';
  assert.equal(readSettings(ctx).apiKey, 'second');
});
