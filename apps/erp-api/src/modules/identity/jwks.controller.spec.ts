import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AccessTokenSigner } from './access-token-signer.js';
import { JwksController } from './jwks.controller.js';

describe('JwksController', () => {
  it('发布可缓存五分钟的标准 JWK Set，包含活动与历史验签公钥', async () => {
    const getPublicJwks = vi.fn().mockResolvedValue({
      keys: [
        { kty: 'RSA', kid: 'signing-current-001', alg: 'RS256', use: 'sig' },
        { kty: 'RSA', kid: 'signing-history-001', alg: 'RS256', use: 'sig' },
      ],
    });
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;
    const controller = new JwksController({ getPublicJwks } as unknown as AccessTokenSigner);

    await expect(controller.jwks(response)).resolves.toMatchObject({
      keys: [
        { kid: 'signing-current-001' },
        { kid: 'signing-history-001' },
      ],
    });
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=300, must-revalidate',
    );
    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/jwk-set+json');
  });
});
