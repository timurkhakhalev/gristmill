import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { containerChannels } from "../../src/contracts/containers.ts";
import { noteChannels } from "../../src/contracts/notes.ts";
import { meetingCoordinatorChannels } from "../../src/contracts/meetingCoordinator.ts";

const repo = path.resolve(__dirname, "../..");

const profile = process.env.GRISTMILL_ELECTRON_FIXTURE_PROFILE;

if (!profile) throw new Error("explicit fixture profile required");

app.setPath("userData", profile);

app.setPath("sessionData", profile);

app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const { build, stop }: typeof import("esbuild") = require(
      path.join(repo, "node_modules/esbuild")
    );

    const Database = require(path.join(repo, "node_modules/better-sqlite3"));
    const db = new Database(path.join(profile, "notes.db"));
    db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
    db.prepare("INSERT INTO notes(id, title) VALUES (99, 'Existing note')").run();

    const row = (id: number, title: string) => ({
      id,
      title,
      content: "",
      note_type: "personal",
      space_id: 1,
      folder_id: null,
      folder_ids: [],
      source_file: null,
      audio_duration_seconds: null,
      created_at: "2026-10-05",
      updated_at: "2026-10-05",
      enhanced_content: null,
      enhancement_prompt: null,
      enhanced_at_content_hash: null,
      transcript: null,
      calendar_event_id: null,
      participants: null,
      diarization_enabled: null,
      expected_speaker_count: null,
    });

    let releaseSpaces: (() => void) | undefined;
    let spaces = Promise.resolve();
    ipcMain.handle(containerChannels.getSpaces, async () => {
      await spaces;

      return [
        {
          id: 1,
          name: "Personal",
          emoji: null,
          kind: "private",
          sort_order: 0,
          created_at: "2026-10-05",
          updated_at: "2026-10-05",
        },
      ];
    });

    for (const channel of [containerChannels.getFolders, containerChannels.getFolderNoteCounts])
      ipcMain.handle(channel, () => []);
    ipcMain.handle(noteChannels.getNotes, () => [row(99, "Existing note")]);

    for (const channel of [
      "get-pending-note-navigation",
      meetingCoordinatorChannels.getPendingMeetingNoteNavigation,
      meetingCoordinatorChannels.findCalendarEventNote,
    ])
      ipcMain.handle(channel, () => null);
    ipcMain.handle("get-log-level", () => "error");
    ipcMain.handle("app-log", () => {});
    ipcMain.handle(noteChannels.saveNote, (_event, title: string) => {
      const id = Number(
        db.prepare("INSERT INTO notes(title) VALUES (?)").run(title).lastInsertRowid
      );

      return { success: true, note: row(id, title) };
    });
    const renderer = path.join(profile, "renderer.js");
    const empty = "export default function Empty(){return null;}";

    const mocks: Record<string, string> = {
      "react-i18next":
        'export const initReactI18next={type:"3rdParty",init(){}};const t=key=>key;export function useTranslation(){return {t,i18n:{resolvedLanguage:"en"}};}',
      "/ui/useToast": "export function useToast(){return {toast(){}};}",
      "/stores/actionStore": "export async function initializeActions(){}",
      "/services/ReasoningService.js": "export default {clearApiKeyCache(){}};",
      "/controlPanelNav": "export function useControlPanelNavItems(){return [];}",
      "/stores/meetingRecordingStore":
        "const state={isRecording:true,recordingNoteId:null};export function useMeetingRecordingStore(selector){return selector(state)};useMeetingRecordingStore.getState=()=>state;export function useIsMeetingMode(){return false}export function startRecording(){}export function resumeMeeting(){}",
      "/notes/PersonalNotesView": `import React from "react";import {useActiveNoteId} from ${JSON.stringify(path.join(repo, "src/stores/noteStore.ts"))};export default function Notes(){return React.createElement("div",{"data-note-id":useActiveNoteId()})}`,
      "/notes/EventNoteDraft":
        'import React from "react";export default function Draft({event}){return React.createElement("div",{"data-event-id":event.id})}',
      "/SettingsModal":
        'import React from "react";export default function Settings(){return React.createElement("div",{"data-settings":"open"})}',
      "/ui/dialog":
        "const empty=()=>null;export {empty as Dialog,empty as DialogContent,empty as DialogFooter,empty as DialogHeader,empty as DialogTitle};",
      "/home/HomeSkeleton": "export function HomeSkeleton(){return null;}",
    };

    for (const leaf of [
      "ControlPanelSidebar",
      "ControlPanelTopBar",
      "ControlPanelNavDrawer",
      "MeetingRecordingMount",
      "notes/MeetingRecordingPill",
      "notes/BackgroundActionToastListener",
      "home/HomeView",
      "notes/UploadAudioView",
      "CommandSearch",
      "KeyboardShortcutsDialog",
      "notes/NotesDebugPreview",
      "notes/NoteSkeleton",
    ])
      mocks[`/${leaf}`] = empty;

    try {
      await build({
        stdin: {
          contents: `import React from "react";import {createRoot} from "react-dom/client";import {flushSync} from "react-dom";
    import ControlPanel from ${JSON.stringify(path.join(repo, "src/components/ControlPanel.tsx"))};
    import {useIsTreeLoading,useSpaces} from ${JSON.stringify(path.join(repo, "src/stores/noteStore.ts"))};
    function Fixture(){const loading=useIsTreeLoading();const spaces=useSpaces();React.useEffect(()=>{window.panelReady=!loading&&spaces.length>0;});return React.createElement(ControlPanel);}
    let root;window.mountPanel=()=>{root=createRoot(document.getElementById("root"));root.render(React.createElement(Fixture));};
    window.flushPanel=()=>flushSync(()=>root.render(React.createElement(Fixture)));
    window.unmountPanel=()=>{root.unmount();};window.bootstrapReady=true;`,
          resolveDir: repo,
        },
        outfile: renderer,
        bundle: true,
        platform: "browser",
        format: "iife",
        define: { "import.meta.env": '{"DEV":false}' },
        plugins: [
          {
            name: "fixture-leaves",
            setup(plugin) {
              plugin.onResolve({ filter: /.*/ }, (args) => {
                const key = Object.keys(mocks).find((suffix) => args.path.endsWith(suffix));

                return key ? { path: key, namespace: "fixture" } : undefined;
              });
              plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                contents: mocks[args.path],
                resolveDir: repo,
              }));
            },
          },
        ],
        logLevel: "silent",
      });
    } finally {
      stop();
    }

    const server = http.createServer((request, response) =>
      response.end(
        request.url === "/renderer.js"
          ? fs.readFileSync(renderer)
          : '<html><div id="root"></div><script src="/renderer.js"></script></html>'
      )
    );

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(repo, "dist-main/preload.js"),
        contextIsolation: true,
        sandbox: true,
      },
    });

    const { WindowManager } = require(path.join(repo, "dist-main/src/helpers/windowManager.js"));
    const manager = Object.create(WindowManager.prototype);
    manager.controlPanelWindow = win;
    manager.createControlPanelWindow = async () => {};

    const waitFor = async (expression: string) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await new Promise((done) => setTimeout(done, 10));
      }

      throw new Error(`observable action missing: ${expression}`);
    };

    try {
      const missing: string[] = [];

      for (const phase of ["before", "after", "reload", "remount"] as const)
        for (const action of ["note", "event", "settings"] as const) {
          spaces = new Promise((done) => {
            releaseSpaces = done;
          });

          const loading = win.loadURL(
            `http://127.0.0.1:${(server.address() as { port: number }).port}/?${phase}-${action}`
          );

          const send = async () => {
            if (action === "note") await manager.requestNewNote();
            else if (action === "event")
              await manager.requestOpenCalendarEvent({
                id: `${phase}-event`,
                summary: "Meeting",
                start_time: new Date().toISOString(),
              });
            else await manager.openSettings();
          };

          if (phase === "reload") await send();
          await loading;
          await waitFor("window.bootstrapReady === true");

          if (phase === "remount") {
            releaseSpaces!();
            await win.webContents.executeJavaScript("window.mountPanel()");
            await waitFor("window.panelReady === true");
            await win.webContents.executeJavaScript("window.unmountPanel()");
            spaces = new Promise((done) => {
              releaseSpaces = done;
            });
            await send();
            await new Promise((done) => setTimeout(done, 20));
          }

          if (phase === "before") {
            await send();
            await new Promise((done) => setTimeout(done, 20));
          }

          if (phase === "after") releaseSpaces!();
          await win.webContents.executeJavaScript("window.mountPanel()");

          if (phase !== "after") {
            await new Promise((done) => setTimeout(done, 20));

            if (action === "note" && phase !== "remount")
              assert.equal(
                await win.webContents.executeJavaScript(
                  "document.querySelector('[data-note-id]') !== null"
                ),
                false
              );
            releaseSpaces!();
          } else {
            await waitFor("window.panelReady === true");
            await send();
          }

          await waitFor("window.panelReady === true");
          await win.webContents.executeJavaScript("window.flushPanel()");

          try {
            await waitFor(
              action === "note"
                ? "document.querySelector('[data-note-id]')?.getAttribute('data-note-id') > 0"
                : action === "event"
                  ? `document.querySelector('[data-event-id]')?.getAttribute('data-event-id') === '${phase}-event'`
                  : "document.querySelector('[data-settings]') !== null"
            );
          } catch {
            missing.push(`${phase}:${action}`);
          }

          assert.equal(win.isVisible(), false, "delivery never overrides visibility authority");
        }

      assert.deepEqual(missing, [], "all actions must reach their mounted owner");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id != 99").get().count, 4);
      console.log(
        "tray readiness actions passed: before/after subscription, document reload and remount retry; 4 persisted Notes"
      );
    } finally {
      win.destroy();
      server.close();
      db.close();
    }

    app.exit(0);
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
