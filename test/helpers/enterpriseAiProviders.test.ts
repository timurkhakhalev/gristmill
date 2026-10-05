const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { getEnterpriseAIModel } = require("../../src/helpers/enterpriseAiProviders.ts");

const {
  mapEnterpriseError,
}: typeof import("../../src/helpers/enterpriseProviderErrors.ts") = require("../../src/helpers/enterpriseProviderErrors.ts");

const bedrockPrompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

type EnterpriseModel = Awaited<ReturnType<typeof getEnterpriseAIModel>>;

async function captureBedrockGenerationError(model: EnterpriseModel) {
  let error: unknown;
  await assert.rejects(model.doGenerate({ prompt: bedrockPrompt } as never), (caught: unknown) => {
    error = caught;

    return true;
  });

  return error as Error;
}

test("direct Bedrock credentials are passed to the real SDK", async (t: import("node:test").TestContext) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request: { url: string; headers: Record<string, string> } | undefined;
  global.fetch = async (url: unknown, init?: { headers?: unknown }) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init!.headers as never)),
    };

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const model = await getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
    bedrockRegion: "us-west-2",
    bedrockAccessKeyId: "AKIAEXAMPLE",
    bedrockSecretAccessKey: "example-secret",
    bedrockSessionToken: "example-session-token",
  });

  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.match(request!.url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\//);
  assert.match(request!.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(request!.headers["x-amz-security-token"], "example-session-token");
});

test("real Bedrock provider maps header-only AWS exception identities", async (t: import("node:test").TestContext) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  for (const scenario of [
    {
      label: "authentication",
      status: 403,
      exceptionHeader: "InvalidClientTokenId:client",
      requestId: "auth-request-123",
      body: { message: "The security token included in the request is invalid" },
      expectedMessage:
        "AWS credentials were rejected. Check the access key ID, secret, and session token.",
      expectedExceptionType: "InvalidClientTokenId",
      expectedRetryable: undefined,
    },
    {
      label: "model not found",
      status: 404,
      exceptionHeader: "com.amazon.bedrock#ResourceNotFoundException",
      requestId: "model-request-123",
      body: { message: "The requested model was not found" },
      expectedMessage:
        "AWS Bedrock could not find the selected model in region us-west-2. Check the model ID and whether it is available in that region.",
      expectedExceptionType: "ResourceNotFoundException",
      expectedRetryable: undefined,
    },
    {
      label: "service unavailable",
      status: 503,
      exceptionHeader: "com.amazon.bedrock#ServiceUnavailableException:retry",
      requestId: "unavailable-request-123",
      body: { message: "Service unavailable" },
      expectedMessage:
        "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an Gristmill outage. Please try again in a few minutes.",
      expectedExceptionType: "ServiceUnavailableException",
      expectedRetryable: true,
    },
  ]) {
    global.fetch = async () =>
      new Response(JSON.stringify(scenario.body), {
        status: scenario.status,
        headers: {
          "Content-Type": "application/json",
          "X-Amzn-ErrorType": scenario.exceptionHeader,
          "X-Amzn-RequestId": scenario.requestId,
        },
      });

    const model = await getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
      bedrockRegion: "us-west-2",
      bedrockAccessKeyId: "AKIAEXAMPLE",
      bedrockSecretAccessKey: "example-secret",
    });

    const error = await captureBedrockGenerationError(model);
    const mapped = mapEnterpriseError("bedrock", error, { bedrockRegion: "us-west-2" });

    assert.equal(error.name, "AI_APICallError", scenario.label);
    assert.equal(mapped.message, scenario.expectedMessage, scenario.label);
    assert.equal(mapped.retryable, scenario.expectedRetryable, scenario.label);
    assert.deepEqual(
      mapped.technicalDetails,
      {
        status: scenario.status,
        exceptionType: scenario.expectedExceptionType,
        requestId: scenario.requestId,
        underlyingError: scenario.body.message,
      },
      scenario.label
    );
  }
});

test("explicit Bedrock credential sources cannot fall through to populated AWS environment", async (t: import("node:test").TestContext) => {
  const environmentKeys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

  const originalEnvironment = new Map(
    environmentKeys.map((key) => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(process.env, key),
        value: process.env[key],
      },
    ])
  );

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  process.env.AWS_ACCESS_KEY_ID = "AKIAENVIRONMENT";
  process.env.AWS_SECRET_ACCESS_KEY = "environment-secret";
  process.env.AWS_SESSION_TOKEN = "environment-session-token";
  global.fetch = async () => {
    fetchCalls += 1;

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  t.after(() => {
    global.fetch = originalFetch;

    for (const [key, original] of originalEnvironment) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
  });

  for (const [label, enterprise] of [
    ["partial manual static keys", { bedrockAccessKeyId: "AKIAEXPLICIT" }],
  ] as Array<[string, Record<string, string>]>) {
    await assert.rejects(
      getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
        bedrockRegion: "us-west-2",
        ...enterprise,
      }),
      (error: unknown) =>
        (error as { name?: string })?.name === "CredentialsProviderError" &&
        /accessKeyId and secretAccessKey/.test((error as Error).message),
      label
    );
  }

  assert.equal(fetchCalls, 0);
});

test("Bedrock environment fallback remains available without an explicit credential source", async (t: import("node:test").TestContext) => {
  const environmentKeys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

  const originalEnvironment = new Map(
    environmentKeys.map((key) => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(process.env, key),
        value: process.env[key],
      },
    ])
  );

  const originalFetch = global.fetch;
  let request: { url: string; headers: Record<string, string> } | undefined;
  process.env.AWS_ACCESS_KEY_ID = "AKIAENVIRONMENT";
  process.env.AWS_SECRET_ACCESS_KEY = "environment-secret";
  process.env.AWS_SESSION_TOKEN = "environment-session-token";
  global.fetch = async (url: unknown, init?: { headers?: unknown }) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init!.headers as never)),
    };

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  t.after(() => {
    global.fetch = originalFetch;

    for (const [key, original] of originalEnvironment) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
  });

  const model = await getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
    bedrockRegion: "us-west-2",
  });

  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );

  assert.match(request!.url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\//);
  assert.match(request!.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(request!.headers["x-amz-security-token"], "environment-session-token");
});

test("direct Azure setup uses API-key auth", async (t: import("node:test").TestContext) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request: { url: string; headers: Record<string, string>; body: unknown } | undefined;
  global.fetch = async (url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init!.headers as never)),
      body: JSON.parse(String(init!.body)),
    };

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const model = await getEnterpriseAIModel("azure", "deployment-a", "direct-api-key", {
    azureEndpoint: "https://legacy.example.com/custom/openai",
    azureApiVersion: "2024-10-21",
  });

  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(request!.url, "https://legacy.example.com/custom/openai/responses");
  assert.equal(request!.headers["api-key"], "direct-api-key");
  assert.equal((request!.body as { model: string }).model, "deployment-a");
});

test("manual Azure setup preserves legacy endpoints and API-key auth", async (t: import("node:test").TestContext) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request: { url: string; headers: Record<string, string> } | undefined;
  global.fetch = async (url: unknown, init?: { headers?: unknown }) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init!.headers as never)),
    };

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const model = await getEnterpriseAIModel("azure", "legacy-deployment", "legacy-api-key", {
    azureEndpoint: "https://legacy.example.com/custom/openai",
    azureApiVersion: "2024-10-21",
  });

  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(request!.url, "https://legacy.example.com/custom/openai/responses");
  assert.equal(request!.headers["api-key"], "legacy-api-key");
});
