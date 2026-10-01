const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
const generateCalls : unknown[] = [];
let generateBehavior: (options: unknown) => Promise<unknown> = async () => ({ text: "hello", finishReason: "stop" });
let handlerContext;

const electronStub = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => listeners.set(channel, fn),
    removeHandler: () => {},
  },
  net: {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    }),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") return electronStub;
  if ((parent as { filename?: string } | null)?.filename === handlersModulePath) {
    if (request === "./debugLogger") {
      return new Proxy({}, { get: () => () => {} });
    }
    if (request === "ai") {
      return {
        generateText: async (options: unknown) => {
          generateCalls.push(options);
          return generateBehavior(options);
        },
      };
    }
    if (request === "./enterpriseAiProviders") {
      return {
        getEnterpriseAIModel: async (_provider: string, _model: string, _apiKey: string, _enterprise: unknown) => {
          return { provider: "bedrock-test-model" };
        },
      };
    }
    if (request === "./cortiTranscription") {
      return { transcribeAudio: async () => ({ text: "corti text" }) };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async () => ({ text: "tinfoil text", model: "tinfoil-model" }),
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything(): unknown {
  return new Proxy(function () {}, {
    get: (target: object, property: string | symbol) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const { AgentStreamRequestRegistry }: typeof import("../../src/helpers/agentStreamRequestRegistry") = require("../../src/helpers/agentStreamRequestRegistry");
  const target = {
    sessionId: "test-session",
    _enterpriseReasoningRequests: new AgentStreamRequestRegistry(),
  };
  return new Proxy(target, {
    get: (value: object, property: string | symbol) => (property in value ? (value as Record<string, unknown>)[property as string] : anything()),
  });
}

function sender(id: unknown) {
  const eventListeners = new Map<unknown, (event: unknown) => void>();
  let destroyed = false;
  return {
    id,
    once: (event: unknown, listener: (event: unknown) => void) => eventListeners.set(event, listener),
    removeListener: (event: unknown, listener: (event: unknown) => void) => {
      if (eventListeners.get(event) === listener) eventListeners.delete(event);
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      eventListeners.get("destroyed")?.(undefined);
    },
  };
}

function retryable503() {
  return Object.assign(new Error("Bedrock overloaded"), {
    name: "ServiceUnavailableException",
    statusCode: 503,
    responseHeaders: { "x-amzn-requestid": "aws-request-503" },
  });
}



test.before(() => {
  delete require.cache[handlersModulePath];
  const Ctor: typeof import("../../src/helpers/ipcHandlers.ts").IPCHandlers = require(handlersModulePath);
  handlerContext = buildFakeThis();
  Ctor.prototype.setupHandlers.call(handlerContext);
  assert.ok(handlers.get("test-enterprise-connection"));
  assert.ok(handlers.get("process-enterprise-reasoning"));
  assert.ok(listeners.get("enterprise-reasoning-cancel"));
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  generateCalls.length = 0;
});

test("Check connection asks for at least 16 output tokens, the Azure Responses API minimum", async () => {
  // Live 2026-09-07: Azure rejected the probe with "Invalid 'max_output_tokens':
  // integer below minimum value. Expected a value >= 16, but got 10 instead."
  const probes = [
    ["bedrock", { model: "anthropic.claude-haiku", bedrockRegion: "eu-west-1" }],
    ["azure", { model: "gpt-4.1-mini", azureEndpoint: "https://acme.openai.azure.com" }],
  ];
  for (const [provider, config] of probes as Array<[string, unknown]>) {
    const result: unknown = await handlers.get("test-enterprise-connection")!(
      { sender: sender(3) },
      provider,
      config
    );
    assert.deepEqual(result, { success: true }, provider);
  }
  assert.equal(generateCalls.length, probes.length);
  for (const call of generateCalls as Array<{ maxOutputTokens: number }>) {
    assert.ok(
      call.maxOutputTokens >= 16,
      `maxOutputTokens ${call.maxOutputTokens} is below Azure's minimum of 16`
    );
  }
});

test("Check connection uses the Bedrock retry policy and disables nested AI SDK retries", async () => {
  let attempts = 0;
  generateBehavior = async () => {
    attempts += 1;
    if (attempts === 1) throw retryable503();
    return { text: "hello", finishReason: "stop" };
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result: unknown = await handlers.get("test-enterprise-connection")!(
      { sender: sender(2) },
      "bedrock",
      {
        model: "anthropic.claude-haiku",
        bedrockRegion: "eu-west-1",
      }
    );

    assert.deepEqual(result, { success: true });
    assert.equal(generateCalls.length, 2);
    assert.ok(generateCalls.every((call: unknown) => (call as { maxRetries: number }).maxRetries === 0));
  } finally {
    Math.random = originalRandom;
  }
});

test("Check connection retries timed-out Bedrock attempts with the existing timeout message", async () => {
  let attempts = 0;
  generateBehavior = async (rawOptions: unknown) => {
    const options = rawOptions as { abortSignal: AbortSignal };
    attempts += 1;
    await new Promise((resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
        once: true,
      });
    });
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  let watchdog!: ReturnType<typeof setTimeout>;
  try {
    const request: any = handlers.get("test-enterprise-connection")!({ sender: sender(1) }, "bedrock", {
      model: "anthropic.claude-haiku",
      bedrockRegion: "eu-west-1",
      timeoutMs: 5,
    });
    const result = await Promise.race([
      request,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Bedrock timeout did not settle")), 250);
      }),
    ]);

    assert.equal(attempts, 6);
    assert.equal(
      result.error,
      "AWS Bedrock did not respond in time. Please try again. If this continues, check your internet connection and AWS Bedrock service status."
    );
  } finally {
    clearTimeout(watchdog);
    Math.random = originalRandom;
  }
});

test("cleanup uses the Bedrock retry policy and returns the eventual text", async () => {
  let attempts = 0;
  generateBehavior = async () => {
    attempts += 1;
    if (attempts === 1) throw retryable503();
    return { text: "cleaned dictation", finishReason: "stop" };
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result: unknown = await handlers.get("process-enterprise-reasoning")!(
      { sender: sender(3) },
      "raw dictation",
      "anthropic.claude-haiku",
      null,
      {
        provider: "bedrock",
        inferenceScope: "cleanup",
        bedrockRegion: "eu-west-1",
        systemPrompt: "Clean the dictation",
      }
    );

    assert.deepEqual(result, { success: true, text: "cleaned dictation" });
    assert.equal(generateCalls.length, 2);
    assert.ok(generateCalls.every((call: unknown) => (call as { maxRetries: number }).maxRetries === 0));
  } finally {
    Math.random = originalRandom;
  }
});

test("note formatting preserves the AI SDK retry policy", async () => {
  generateBehavior = async () => {
    throw retryable503();
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result: any = await handlers.get("process-enterprise-reasoning")!(
      { sender: sender(6) },
      "translate this",
      "anthropic.claude-haiku",
      null,
      {
        provider: "bedrock",
        inferenceScope: "noteFormatting",
        bedrockRegion: "eu-west-1",
        systemPrompt: "Translate it",
      }
    );

    assert.equal(result.success, false);
    assert.equal(generateCalls.length, 1);
    assert.equal("maxRetries" in (generateCalls[0] as object), false);
  } finally {
    Math.random = originalRandom;
  }
});

test("chat intelligence preserves the AI SDK retry policy", async () => {
  generateBehavior = async () => {
    throw retryable503();
  };
  const result: any = await handlers.get("process-enterprise-reasoning")!(
    { sender: sender(7) },
    "chat message",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "chatIntelligence",
      bedrockRegion: "eu-west-1",
      systemPrompt: "Answer briefly",
    }
  );

  assert.equal(result.success, false);
  assert.equal(generateCalls.length, 1);
  assert.equal("maxRetries" in (generateCalls[0] as object), false);
});

test("Bedrock cleanup cancellation aborts only the requesting renderer without retrying", async () => {
  const requestingSender = sender(10);
  const otherSender = sender(11);
  let attempts = 0;
  let requestSignal!: AbortSignal;
  let releaseRequest!: () => void;
  const started = new Promise<void>((resolve) => (releaseRequest = resolve));
  generateBehavior = async (rawOptions: unknown) => {
    const options = rawOptions as { abortSignal: AbortSignal };
    attempts += 1;
    requestSignal = options.abortSignal;
    releaseRequest();
    await new Promise((resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
        once: true,
      });
    });
  };

  const request = handlers.get("process-enterprise-reasoning")!(
    { sender: requestingSender },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "cleanup",
      bedrockRegion: "eu-west-1",
      systemPrompt: "Clean the dictation",
    }
  );
  await started;
  listeners.get("enterprise-reasoning-cancel")!({ sender: otherSender });
  assert.equal(requestSignal.aborted, false);
  listeners.get("enterprise-reasoning-cancel")!({ sender: requestingSender });
  await request;

  assert.equal(requestSignal.aborted, true);
  assert.equal(attempts, 1);
});

test("Check connection returns AWS diagnostics without a fallback status", async () => {
  generateBehavior = async () => {
    throw Object.assign(new Error("Bad signature"), {
      name: "UnrecognizedClientException",
      statusCode: 401,
      responseHeaders: { "x-amzn-requestid": "connection-request-id" },
    });
  };

  const result: any = await handlers.get("test-enterprise-connection")!(
    { sender: sender(4) },
    "bedrock",
    {
      model: "anthropic.claude-haiku",
      bedrockRegion: "eu-west-1",
    }
  );

  assert.equal(result.success, false);
  assert.match(result.error, /credentials were rejected/i);
  assert.deepEqual(result.technicalDetails, {
    status: 401,
    exceptionType: "UnrecognizedClientException",
    requestId: "connection-request-id",
    underlyingError: "Bad signature",
  });
  assert.equal("fallbackStatus" in result, false);
});

test("cleanup returns preserved AWS diagnostics to the renderer", async () => {
  generateBehavior = async () => {
    throw Object.assign(new Error("Not allowed to invoke model"), {
      name: "AccessDeniedException",
      statusCode: 403,
      responseHeaders: { "x-amzn-requestid": "cleanup-request-id" },
    });
  };

  const result: any = await handlers.get("process-enterprise-reasoning")!(
    { sender: sender(5) },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "cleanup",
      bedrockRegion: "eu-west-1",
      systemPrompt: "Clean it",
    }
  );

  assert.equal(result.success, false);
  assert.match(result.error, /denied this request/i);
  assert.deepEqual(result.technicalDetails, {
    status: 403,
    exceptionType: "AccessDeniedException",
    requestId: "cleanup-request-id",
    underlyingError: "Not allowed to invoke model",
  });
});
