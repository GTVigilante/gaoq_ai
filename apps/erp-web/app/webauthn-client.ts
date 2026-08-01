interface CredentialDescriptorJSON {
  readonly id: string;
  readonly type: 'public-key';
  readonly transports?: readonly AuthenticatorTransport[];
}

interface RegistrationOptionsJSON {
  readonly challenge: string;
  readonly rp: PublicKeyCredentialRpEntity;
  readonly user: Omit<PublicKeyCredentialUserEntity, 'id'> & { readonly id: string };
  readonly pubKeyCredParams: readonly PublicKeyCredentialParameters[];
  readonly timeout?: number;
  readonly attestation?: AttestationConveyancePreference;
  readonly authenticatorSelection?: AuthenticatorSelectionCriteria;
  readonly excludeCredentials?: readonly CredentialDescriptorJSON[];
}

interface AuthenticationOptionsJSON {
  readonly challenge: string;
  readonly rpId?: string;
  readonly timeout?: number;
  readonly userVerification?: UserVerificationRequirement;
  readonly allowCredentials?: readonly CredentialDescriptorJSON[];
}

/** 将服务端 base64url WebAuthn JSON 转成浏览器原生 BufferSource，响应再转回 JSON。 */
export async function createPasskey(options: RegistrationOptionsJSON): Promise<Record<string, unknown>> {
  const { challenge, user, pubKeyCredParams, excludeCredentials, ...rest } = options;
  const credential = await navigator.credentials.create({
    publicKey: {
      ...rest,
      challenge: decodeBase64Url(challenge),
      user: { ...user, id: decodeBase64Url(user.id) },
      ...(excludeCredentials === undefined
        ? {}
        : {
            excludeCredentials: excludeCredentials.map((item) => ({
              type: item.type,
              id: decodeBase64Url(item.id),
              ...(item.transports === undefined ? {} : { transports: [...item.transports] }),
            })),
          }),
      pubKeyCredParams: [...pubKeyCredParams],
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('webauthn unavailable');
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) throw new Error('registration invalid');
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
      transports: response.getTransports(),
    },
  };
}

export async function getPasskeyAssertion(
  options: AuthenticationOptionsJSON,
): Promise<Record<string, unknown>> {
  const { challenge, allowCredentials, ...rest } = options;
  const credential = await navigator.credentials.get({
    publicKey: {
      ...rest,
      challenge: decodeBase64Url(challenge),
      ...(allowCredentials === undefined
        ? {}
        : {
            allowCredentials: allowCredentials.map((item) => ({
              type: item.type,
              id: decodeBase64Url(item.id),
              ...(item.transports === undefined ? {} : { transports: [...item.transports] }),
            })),
          }),
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('webauthn unavailable');
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) throw new Error('assertion invalid');
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      authenticatorData: encodeBase64Url(response.authenticatorData),
      signature: encodeBase64Url(response.signature),
      userHandle: response.userHandle === null ? undefined : encodeBase64Url(response.userHandle),
    },
  };
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = window.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
