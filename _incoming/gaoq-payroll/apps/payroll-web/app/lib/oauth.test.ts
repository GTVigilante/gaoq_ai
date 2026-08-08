import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createPkce } from './oauth.js';

describe('算薪 Web OAuth PKCE', () => {
  it('生成符合 S256 的 verifier 和 challenge', () => {
    const value = createPkce();
    expect(value.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(value.challenge).toBe(
      createHash('sha256').update(value.verifier).digest('base64url'),
    );
  });
});
