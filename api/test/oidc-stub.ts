import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const STUB_ISSUER = 'https://accounts.google.com';
const ISSUER = STUB_ISSUER;
const KID = 'stub-key';

interface IdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  nonce: string;
}

// An in-process OpenID provider: it answers the discovery, JWKS, token, and
// userinfo requests openid-client makes, signing a real RS256 id_token. Wired
// through customFetch so no server or port is involved. Set the next id_token
// claims with setClaims before driving the code exchange.
export class OidcStub {
  private privateKey!: CryptoKey;
  private jwks!: object;
  private claims: IdTokenClaims | null = null;
  readonly clientId = 'stub-client-id';

  static async create(): Promise<OidcStub> {
    const stub = new OidcStub();
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    stub.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    stub.jwks = { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
    return stub;
  }

  setClaims(claims: IdTokenClaims): void {
    this.claims = claims;
  }

  private async idToken(): Promise<string> {
    if (!this.claims) {
      throw new Error('stub id token claims not set');
    }
    return new SignJWT({
      email: this.claims.email,
      email_verified: this.claims.email_verified,
      nonce: this.claims.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setSubject(this.claims.sub)
      .setAudience(this.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.privateKey);
  }

  // Drop-in for the global fetch, handed to the openid-client Configuration.
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url === `${ISSUER}/jwks`) {
      return json(this.jwks);
    }
    if (url === `${ISSUER}/token`) {
      return json({
        access_token: 'stub-access-token',
        token_type: 'Bearer',
        id_token: await this.idToken(),
        expires_in: 3600,
      });
    }
    if (url === `${ISSUER}/userinfo`) {
      return json({ sub: this.claims?.sub, email: this.claims?.email });
    }
    void init;
    throw new Error(`unexpected stub OIDC request: ${url}`);
  };
}
