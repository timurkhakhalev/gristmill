// Attested access to Tinfoil.
// The SDK's SecureClient verifies the enclave and pins the connection to the attested key;
// one client is held per session so attestation is paid once and shared by every caller.
interface SecureClientLike {
  fetch(path: string, init?: Record<string, unknown>): Promise<Response>;
  createWebSocket(
    path: string,
    options?: { wsOptions?: { headers?: Record<string, string> } }
  ): unknown;
}

let clientPromise: Promise<SecureClientLike> | null = null;

function getSecureClient(): Promise<SecureClientLike> {
  if (!clientPromise) {
    // ESM-only package, loaded from CommonJS.
    clientPromise = import("tinfoil").then(({ SecureClient }) => new SecureClient());
    // Don't cache a failed import — the next dictation should retry.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }

  return clientPromise;
}

export async function createTinfoilRealtimeSocket({
  model,
  apiKey,
}: {
  model: string;
  apiKey: string;
}): Promise<unknown> {
  const client = await getSecureClient();
  const path = `/v1/realtime?model=${encodeURIComponent(model)}&intent=transcription`;

  return client.createWebSocket(path, {
    wsOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
}

/** Fetches an enclave path over the attested transport. Needs no API key. */
export async function tinfoilSecureFetch(
  path: string,
  init?: Record<string, unknown>
): Promise<Response> {
  const client = await getSecureClient();

  return client.fetch(path, init);
}
