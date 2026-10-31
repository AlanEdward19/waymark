import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  X509Certificate,
} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADO_SCOPE, entraTokenProvider, GRAPH_SCOPE } from '../src/connectors/auth/entra.js';

// Minimal DER builder: just enough for a self-signed certificate generated in the test.
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
};
const algo = der(0x30, der(0x06, Buffer.from('2a864886f70d01010b', 'hex')), Buffer.from([5, 0]));
const name = der(
  0x30,
  der(
    0x31,
    der(0x30, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('waymark-test'))),
  ),
);
const utc = (s: string) => der(0x17, Buffer.from(s));

function selfSigned() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algo,
    name,
    der(0x30, utc('260101000000Z'), utc('360101000000Z')),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = createSign('RSA-SHA256').update(tbs).sign(privateKey);
  const cert = der(0x30, tbs, algo, der(0x03, Buffer.from([0]), sig));
  const b64 = cert.toString('base64').replace(/(.{64})/g, '$1\n');
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    pem: `${key}-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    cert,
  };
}

const T0 = Date.UTC(2026, 0, 1);

function fake(
  respond: () => Response = () => Response.json({ access_token: 'tok1', expires_in: 3600 }),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('entraTokenProvider', () => {
  it('uses the client secret', async () => {
    const f = fake();
    const p = entraTokenProvider({
      scope: ADO_SCOPE,
      env: { AZURE_TENANT_ID: 't1', AZURE_CLIENT_ID: 'c1', AZURE_CLIENT_SECRET: 's3cret' },
      fetchImpl: f.fetchImpl,
      now: () => T0,
    });
    expect(await p.getToken()).toBe('tok1');
    expect(f.calls[0]?.url).toBe('https://login.microsoftonline.com/t1/oauth2/v2.0/token');
    expect(f.calls[0]?.init.method).toBe('POST');
    expect(f.calls[0]?.init.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0]?.init.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'c1',
      scope: ADO_SCOPE,
      client_secret: 's3cret',
    });
  });

  it('uses a certificate assertion that verifies with the certificate key', async () => {
    const { pem, cert } = selfSigned();
    expect(new X509Certificate(cert).subject).toContain('waymark-test');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    const file = path.join(dir, 'cert.pem');
    await fs.writeFile(file, pem);
    const f = fake();
    const p = entraTokenProvider({
      scope: GRAPH_SCOPE,
      env: {
        AZURE_TENANT_ID: 't1',
        AZURE_CLIENT_ID: 'c1',
        AZURE_CLIENT_CERTIFICATE_PATH: file,
        AZURE_CLIENT_SECRET: 'ignored',
      },
      fetchImpl: f.fetchImpl,
      now: () => T0,
    });
    await p.getToken();
    const body = new URLSearchParams(String(f.calls[0]?.init.body));
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('scope')).toBe(GRAPH_SCOPE);
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    const [h, c, s] = (body.get('client_assertion') ?? '').split('.') as [string, string, string];
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(head).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      'x5t#S256': createHash('sha256').update(cert).digest('base64url'),
    });
    expect(claims).toMatchObject({
      aud: 'https://login.microsoftonline.com/t1/oauth2/v2.0/token',
      iss: 'c1',
      sub: 'c1',
      nbf: T0 / 1000,
      exp: T0 / 1000 + 600,
    });
    expect(typeof claims.jti).toBe('string');
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(new X509Certificate(cert).publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
  });

  it('uses managed identity via IMDS, with optional client id and expires_on', async () => {
    const f = fake(() =>
      Response.json({ access_token: 'mi', expires_on: String(T0 / 1000 + 3600) }),
    );
    const p = entraTokenProvider({
      scope: ADO_SCOPE,
      env: { WAYMARK_USE_MANAGED_IDENTITY: '1', AZURE_CLIENT_ID: 'uami' },
      fetchImpl: f.fetchImpl,
      now: () => T0,
    });
    expect(await p.getToken()).toBe('mi');
    const u = new URL(f.calls[0]?.url ?? '');
    expect(`${u.origin}${u.pathname}`).toBe(
      'http://169.254.169.254/metadata/identity/oauth2/token',
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      'api-version': '2018-02-01',
      resource: 'https://app.vssps.visualstudio.com',
      client_id: 'uami',
    });
    expect(f.calls[0]?.init.method).toBe('GET');
    expect(f.calls[0]?.init.headers).toEqual({ Metadata: 'true' });
  });

  it('system-assigned managed identity sends no client_id', async () => {
    const f = fake();
    await entraTokenProvider({
      scope: GRAPH_SCOPE,
      env: { WAYMARK_USE_MANAGED_IDENTITY: '1' },
      fetchImpl: f.fetchImpl,
    }).getToken();
    expect(new URL(f.calls[0]?.url ?? '').searchParams.has('client_id')).toBe(false);
  });

  it('secret wins over managed identity', async () => {
    const f = fake();
    await entraTokenProvider({
      scope: ADO_SCOPE,
      env: {
        AZURE_TENANT_ID: 't',
        AZURE_CLIENT_ID: 'c',
        AZURE_CLIENT_SECRET: 's',
        WAYMARK_USE_MANAGED_IDENTITY: '1',
      },
      fetchImpl: f.fetchImpl,
    }).getToken();
    expect(f.calls[0]?.url).toContain('login.microsoftonline.com');
  });

  it('reuses the token until 5 minutes before expiry', async () => {
    const f = fake();
    let t = T0;
    const p = entraTokenProvider({
      scope: ADO_SCOPE,
      env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
      fetchImpl: f.fetchImpl,
      now: () => t,
    });
    await p.getToken();
    t = T0 + 3600_000 - 5 * 60_000 - 1;
    await p.getToken();
    expect(f.calls).toHaveLength(1);
    t = T0 + 3600_000 - 5 * 60_000;
    await p.getToken();
    expect(f.calls).toHaveLength(2);
  });

  it('surfaces token endpoint errors without secrets', async () => {
    const f = fake(() =>
      Response.json(
        { error: 'invalid_client', error_description: 'AADSTS7000215: bad secret' },
        { status: 400 },
      ),
    );
    const p = entraTokenProvider({
      scope: ADO_SCOPE,
      env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 'topsecret' },
      fetchImpl: f.fetchImpl,
    });
    const err = (await p.getToken().catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      'Entra token request failed: invalid_client AADSTS7000215: bad secret',
    );
    expect(err.message).not.toContain('topsecret');
  });

  it('errors listing the three options when no credentials are set', () => {
    expect(() => entraTokenProvider({ scope: ADO_SCOPE, env: {} })).toThrow(
      /Set one of: \(1\) AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_CERTIFICATE_PATH.*\(2\).*AZURE_CLIENT_SECRET.*\(3\) WAYMARK_USE_MANAGED_IDENTITY=1.*docs\/identities\.md#azure-devops/,
    );
  });
});
