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

// setAppPath exists at runtime; typed as missing in this Electron version.
(app as unknown as { setAppPath(p: string): void }).setAppPath(repo);

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
    process.env.VITE_DEV_SERVER_PORT = String((server.address() as { port: number }).port);
    process.env.NODE_ENV = "development";
    process.env.GRISTMILL_CHANNEL = "development";

    // Compiled main output; loaded at runtime after app ready.
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
    await win.loadURL(`http://localhost:${(server.address() as { port: number }).port}/`);
    await win.webContents.executeJavaScript("localStorage.setItem('uiLanguage', 'fr')");

    const manager = Object.create(WindowManager.prototype) as InstanceType<typeof WindowManager>;
    await manager.loadWindowContent(win, true);

    const imported = (await win.webContents.executeJavaScript("window.firstSettings")) as Record<
      string,
      string | undefined
    >;

    assert.equal(imported.onboardingCompleted, "true", "seeded before the page script");
    assert.equal(imported.uiLanguage, "fr", "existing HTTP setting wins");
    assert.equal(imported.meetingCloudTranscriptionProvider, "deepgram");
    assert.equal(imported["gristmill.paused-meeting"], "stale-paused-meeting");

    await win.webContents.executeJavaScript("localStorage.removeItem('gristmill.paused-meeting')");
    await (
      Object.create(WindowManager.prototype) as InstanceType<typeof WindowManager>
    ).loadWindowContent(win, true);

    const nextLaunch = (await win.webContents.executeJavaScript("window.firstSettings")) as Record<
      string,
      string | undefined
    >;

    assert.equal(nextLaunch["gristmill.paused-meeting"], undefined, "removed state stays removed");
    assert.equal(nextLaunch.uiLanguage, "fr", "existing dev value survives restart");

    await win.webContents.session.clearStorageData();
    await (
      Object.create(WindowManager.prototype) as InstanceType<typeof WindowManager>
    ).loadWindowContent(win, true);

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
    await (
      Object.create(WindowManager.prototype) as InstanceType<typeof WindowManager>
    ).loadWindowContent(win, true);

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
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
