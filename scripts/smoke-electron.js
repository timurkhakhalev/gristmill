// Run sequentially after packaging: node scripts/smoke-electron.js [app executable] [--dev].
// Uses a new temporary profile, no provider keys, no microphone and no calendar access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const WebSocket = require("ws");

async function main() {
  const expectDev = process.argv.includes("--dev");
  const executable =
    process.argv[2] ||
    path.resolve(__dirname, "../dist/mac-arm64/OpenHercules.app/Contents/MacOS/OpenHercules");
  assert.ok(fs.existsSync(executable), `Missing packaged app: ${executable}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-smoke-"));
  console.log(`Smoke profile: ${profile}`);
  const netLogPath = path.join(profile, "network.json");
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/API_KEY|TOKEN|SECRET|^AWS_|^AZURE_|^GOOGLE_|^VERTEX_|^VITE_/.test(key)
  ));
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(
    executable,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--log-net-log=${netLogPath}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, NODE_ENV: "production", OPENHERCULES_CHANNEL: "production" },
    }
  );
  let log = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log += chunk.toString();
    });
  let socket;
  try {
    let target;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}: ${log}`);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = targets.find((item) => item.type === "page" && item.url.includes("panel=true"));
        if (target) break;
      } catch {
        /* Chromium is still starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(target, `No main renderer: ${log}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open");
    let nextId = 0;
    const pending = new Map();
    const exceptions = [];
    const rendererErrors = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        rendererErrors.push(message.params.args.map((arg) => arg.value || arg.description).join(" "));
      }
      if (message.method === "Runtime.exceptionThrown")
        exceptions.push(message.params.exceptionDetails);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send("Runtime.enable");
    let initialReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      initialReady = await evaluate("document.readyState === 'complete' && !!document.body?.innerText.trim()");
      if (initialReady) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(initialReady, "Initial renderer finishes loading before navigation");
    await evaluate(
      `localStorage.setItem("uiLanguage", "en"); localStorage.setItem("onboardingCompleted", "true"); localStorage.setItem("noteFilesEnabled", "false");`
    );
    await send("Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 500));
    let text = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      text = await evaluate("document.body.innerText");
      if (text.includes("Notes")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.match(text, /Notes/, "Notes opens by default");
    assert.doesNotMatch(text, /OpenWhispr|Sign in|Upgrade to Pro/);
    if (expectDev) {
      let debugOpened = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        debugOpened = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Debug');
          button?.click(); return !!button;
        })()`);
        if (debugOpened) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(debugOpened, "Packaged development app exposes Debug menu");
      assert.match(await evaluate("document.body.innerText"), /Notes state preview/);
      const previewOpened = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Blank note');
        button?.click(); return !!button;
      })()`);
      assert.ok(previewOpened, "Debug menu includes note states");
      let previewScenario;
      for (let attempt = 0; attempt < 40; attempt++) {
        previewScenario = await evaluate("document.querySelector('[data-notes-debug-scenario]')?.dataset.notesDebugScenario");
        if (previewScenario === "blank") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(previewScenario, "blank");
      const titleEditable = await evaluate(`(() => {
        const title = document.querySelector('[aria-label="Note title"]');
        if (!title?.isContentEditable) return false;
        title.textContent = 'Mock-only title';
        title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        document.querySelector('[data-segment-value="transcript"]')?.click();
        return true;
      })()`);
      assert.ok(titleEditable, "Mock note title is editable");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"Note title\"]')?.textContent"), "Mock-only title");
      assert.deepEqual(await evaluate("window.electronAPI.searchNotes('Mock-only title', 20)"), [], "Mock note is not saved");
      await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')];
        if (!buttons.some((el) => el.textContent.trim() === 'Processing failed')) {
          buttons.find((el) => el.textContent.trim() === 'Debug')?.click();
        }
      })()`);
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Processing failed');
        button?.click(); return !!button;
      })()`);
      let retryClicked = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        retryClicked = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Retry');
          button?.click(); return !!button;
        })()`);
        if (retryClicked) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(retryClicked, "Mock processing controls remain clickable");
      assert.match(await evaluate("document.body.innerText"), /Mock retry queued in memory/);
      await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')];
        if (!buttons.some((el) => el.textContent.trim() === 'Live app')) {
          buttons.find((el) => el.textContent.trim() === 'Debug')?.click();
        }
      })()`);
      for (let attempt = 0; attempt < 40; attempt++) {
        const liveOpened = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Live app');
          button?.click(); return !!button;
        })()`);
        if (liveOpened) break;
        if (attempt === 39) throw new Error("Could not return from mock state to live Notes");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } else {
      assert.doesNotMatch(text, /Debug/, "Production app hides Debug menu");
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const completed = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Get Started');
        if (!button) return false;
        button.click(); return true;
      })()`);
      if (completed) break;
      if (attempt === 59) throw new Error("Notes onboarding did not render its completion button");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await evaluate(`(async () => {
      const api = window.electronAPI;
      await api.noteFilesSetEnabled(false);
      const spaces = await api.getSpaces();
      const folder = await api.createFolder("Smoke folder", spaces[0].id);
      const blank = await api.saveNote("", "", "personal", null, null, folder.folder.id, spaces[0].id);
      const updated = await api.updateNote(blank.note.id, { title: "Smoke meeting", content: "local searchable transcript" });
      const found = await api.searchNotes("searchable", 20);
      const conversation = await api.createAgentConversation("Smoke chat", blank.note.id);
      await api.addAgentMessage(conversation.id, "user", "Summarize this meeting", null);
      const messages = await api.getAgentMessages(conversation.id);
      await api.setDictionary(["OpenHercules", "Smoke"]);
      await api.setSnippets([{ trigger: "smoke", replacement: "Local snippet" }]);
      return { spaces, blank, updated, found, conversation, messages, dictionary: await api.getDictionary(), snippets: await api.getSnippets(), actions: await api.getActions() };
    })()`);
    assert.equal(result.blank.success, true);
    assert.equal(result.updated.success, true);
    assert.ok(result.found.some((note) => note.id === result.blank.note.id));
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.dictionary, ["OpenHercules", "Smoke"]);
    assert.equal(result.snippets[0].replacement, "Local snippet");
    assert.ok(result.actions.length > 0, "Built-in note actions are seeded");
    await send("Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(profile, "smoke.png"), Buffer.from(image.data, "base64"));
    text = await evaluate("document.body.innerText");
    if (rendererErrors.length) console.error(JSON.stringify(rendererErrors, null, 2));
    assert.doesNotMatch(text, /Something went wrong|Minified React error/, "Notes remains rendered after mutations");
    assert.deepEqual(rendererErrors, [], "No caught React errors");
    const settingsOpened = await evaluate(`(() => {
      const button = document.querySelector('button[aria-label="Settings"]');
      button?.click(); return !!button;
    })()`);
    assert.ok(settingsOpened, "Settings opens from the sidebar");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotMatch(await evaluate("document.body.innerText"), /Something went wrong|Minified React error/);
    assert.deepEqual(rendererErrors, [], "Settings has no caught React errors");
    const settingsImage = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(profile, "settings.png"), Buffer.from(settingsImage.data, "base64"));
    assert.deepEqual(exceptions, [], "No unhandled renderer exceptions");
    assert.doesNotMatch(log, /Uncaught Exception|Unhandled Rejection|Failed to start app/);
    console.log(
      JSON.stringify(
        {
          success: true,
          profile,
          checks: [
            "packaged startup",
            "Notes default",
            expectDev ? "interactive in-memory Notes Debug states" : "Debug menu absent",
            "blank note",
            "folder",
            "note edit",
            "local search",
            "embedded chat persistence",
            "dictionary",
            "snippets",
            "built-in actions",
            "notes onboarding completion",
            "settings UI",
          ],
        },
        null,
        2
      )
    );
  } finally {
    socket?.close();
    fs.writeFileSync(path.join(profile, "smoke.log"), log);
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    if (fs.existsSync(netLogPath)) {
      assert.doesNotMatch(fs.readFileSync(netLogPath, "utf8"), /https?:\/\/[^/"\s]*openwhispr\.com/i,
        "No OpenWhispr requests in Chromium/Electron net log");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
