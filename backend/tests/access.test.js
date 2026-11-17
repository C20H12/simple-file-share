import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { checkAccessToken, issueAccessToken } from '../src/access.js';

const HOUR = 3600_000;
const makeShare = (overrides = {}) => ({
  code: '123456',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  ...overrides,
});

describe('access tokens', () => {
  afterEach(() => mock.timers.reset());

  test('a token is valid for the share it was issued for', () => {
    const share = makeShare();
    assert.equal(checkAccessToken(share, issueAccessToken(share).accessToken), true);
  });

  test('a token lasts one hour', () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const share = makeShare();
    const { accessToken, accessExpiresAt } = issueAccessToken(share);
    assert.equal(Date.parse(accessExpiresAt), Date.now() + HOUR);

    mock.timers.tick(HOUR - 1000);
    assert.equal(checkAccessToken(share, accessToken), true);
    mock.timers.tick(2000);
    assert.equal(checkAccessToken(share, accessToken), false);
  });

  test('a token never outlives its share', () => {
    const share = makeShare({ expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    assert.equal(issueAccessToken(share).accessExpiresAt, share.expiresAt);
  });

  test('a token does not work for a different share', () => {
    const { accessToken } = issueAccessToken(makeShare());
    assert.equal(checkAccessToken(makeShare({ code: '654321' }), accessToken), false);
  });

  test('a token does not work for a later share that reuses the code', () => {
    const { accessToken } = issueAccessToken(makeShare());
    assert.equal(checkAccessToken(makeShare({ createdAt: '2026-02-02T00:00:00.000Z' }), accessToken), false);
  });

  test('extending the expiry inside a token invalidates it', () => {
    const share = makeShare();
    const [expiresAt, signature] = issueAccessToken(share).accessToken.split('.');
    assert.equal(checkAccessToken(share, `${Number(expiresAt) + HOUR}.${signature}`), false);
  });

  test('malformed tokens are rejected', () => {
    const share = makeShare();
    for (const token of [undefined, null, '', 'garbage', '.', `${Date.now() + HOUR}`, `${Date.now() + HOUR}.`, 'a.b.c']) {
      assert.equal(checkAccessToken(share, token), false, String(token));
    }
  });
});
