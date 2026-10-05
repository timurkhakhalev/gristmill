import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const repo = path.resolve(__dirname, "../..");

const profile = process.env.GRISTMILL_ELECTRON_FIXTURE_PROFILE;

if (!profile) throw new Error("Electron fixture profile is required");

app.setPath("userData", profile);

app.setPath("sessionData", profile);

// SAFETY: setAppPath exists at runtime but is untyped in this Electron
// version; the chained probe types just that member.
const appWithSetAppPath = app as unknown as {
  setAppPath(p: string): void;
};

appWithSetAppPath.setAppPath(repo);

app
  .whenReady()
  .then(async () => {
    const server = http.createServer(
      (_request: http.IncomingMessage, response: http.ServerResponse) => {
        response.end(
          "<html><script>window.firstSettings = Object.fromEntries(Object.entries(localStorage));</script></html>"
        );
      }
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    // SAFETY: the server listens on 127.0.0.1:0 above; the probe types the
    // reported address.
    const address = server.address() as { port: number };
    process.env.VITE_DEV_SERVER_PORT = String(address.port);
    process.env.NODE_ENV = "development";
    process.env.GRISTMILL_CHANNEL = "development";

    // Compiled main output; loaded at runtime after app ready. SAFETY: the
    // bundle is this repo's own windowManager build.
    const { WindowManager } = require(
      path.join(repo, "dist-main/src/helpers/windowManager.js")
    ) as typeof import("../../src/helpers/windowManager.js");

    const bridge = path.join(repo, "src/dev-storage-bridge.html");

    const win = new BrowserWindow({
      show: false,
      webPreferences: { partition: "persist:gristmill" },
    });

    await win.loadFile(bridge);
    await win.webContents.executeJavaScript(`
    localStorage.setItem("onboardingCompleted", "true");
    localStorage.setItem("uiLanguage", "en");
    localStorage.setItem("meetingCloudTranscriptionProvider", "deepgram");
    localStorage.setItem("gristmill.paused-meeting", "stale-paused-meeting");
  `);
    await win.loadURL(`http://localhost:${address.port}/`);
    await win.webContents.executeJavaScript("localStorage.setItem('uiLanguage', 'fr')");

    // SAFETY: the prototype is the compiled repo's own WindowManager; the
    // assertion types the fixture's instance surface.
    const manager = Object.create(WindowManager.prototype) as InstanceType<typeof WindowManager>;
    await manager.loadWindowContent(win, true);

    // SAFETY: window.firstSettings is the Object.fromEntries(localStorage)
    // copy the fixture page above builds; the assertion types that record.
    const imported = (await win.webContents.executeJavaScript("window.firstSettings")) as Record<
      string,
      string | undefined
    >;

    assert.equal(imported.onboardingCompleted, "true", "seeded before the page script");
    assert.equal(imported.uiLanguage, "fr", "existing HTTP setting wins");
    assert.equal(imported.meetingCloudTranscriptionProvider, "deepgram");
    assert.equal(imported["gristmill.paused-meeting"], "stale-paused-meeting");

    await win.webContents.executeJavaScript("localStorage.removeItem('gristmill.paused-meeting')");
    await manager.loadWindowContent(win, true);

    // SAFETY: window.firstSettings is the fixture's localStorage copy.
    const nextLaunch = (await win.webContents.executeJavaScript("window.firstSettings")) as Record<
      string,
      string | undefined
    >;

    assert.equal(nextLaunch["gristmill.paused-meeting"], undefined, "removed state stays removed");
    assert.equal(nextLaunch.uiLanguage, "fr", "existing dev value survives restart");

    await win.webContents.session.clearStorageData();
    await manager.loadWindowContent(win, true);

    // SAFETY: window.firstSettings is the fixture's localStorage copy.
    const afterReset = (await win.webContents.executeJavaScript("window.firstSettings")) as Record<
      string,
      string | undefined
    >;

    assert.equal(
      afterReset.onboardingCompleted,
      undefined,
      "reset does not reseed stale onboarding"
    );

    await win.loadFile(bridge);
    await win.webContents.executeJavaScript("localStorage.setItem('onboardingCompleted', 'true')");
    const smoke = path.join(profile, "explicit-smoke");
    fs.mkdirSync(smoke);
    app.commandLine.appendSwitch("user-data-dir", smoke);
    assert.equal(app.commandLine.getSwitchValue("user-data-dir"), smoke);
    await manager.loadWindowContent(win, true);

    // SAFETY: window.firstSettings is the fixture's localStorage copy.
    const excluded = (await win.webContents.executeJavaScript("window.firstSettings")) as Record<
      string,
      string | undefined
    >;

    assert.equal(excluded.onboardingCompleted, undefined, "explicit smoke profile skips import");

    console.log("dev renderer origin smoke passed");
    win.destroy();
    server.close();
    app.exit(0);
  })
  .catch((error: Error) => {
    console.error(error.stack);
    app.exit(1);
  });
