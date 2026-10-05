import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app } from "electron";

const tempDir = process.env.GRISTMILL_ELECTRON_FIXTURE_PROFILE;

if (!tempDir) throw new Error("Electron fixture profile is required");

app.setPath("userData", tempDir);

app.setPath("sessionData", tempDir);

app
  .whenReady()
  .then(async () => {
    const { postRawAudioFile } = await import("../../src/helpers/audioFileUpload.js");
    const filePath = path.join(tempDir, "sample.wav");
    const audio = Buffer.from("audio-file-payload");
    fs.writeFileSync(filePath, audio);

    interface Upload {
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }

    const uploads: Upload[] = [];

    const server = http.createServer(
      (request: http.IncomingMessage, response: http.ServerResponse) => {
        if (request.url === "/slow") return;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          uploads.push({ headers: request.headers, body: Buffer.concat(chunks) });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
      }
    );

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const url = new URL(`http://127.0.0.1:${address.port}/upload`);
      assert.deepEqual(await postRawAudioFile(url, filePath, "audio/wav", "test-key"), {
        statusCode: 200,
        data: { ok: true },
      });
      assert.equal(uploads[0].headers.authorization, "Token test-key");
      assert.equal(uploads[0].headers["content-type"], "audio/wav");
      assert.deepEqual(uploads[0].body, audio);

      assert.deepEqual(
        await postRawAudioFile(url, filePath, "audio/wav", "test-key", {
          multipart: { fileName: "sample.wav", fields: { model_id: "scribe_v2" } },
        }),
        { statusCode: 200, data: { ok: true } }
      );
      assert.equal(uploads[1].headers["xi-api-key"], "test-key");
      assert.match(String(uploads[1].headers["content-type"]), /^multipart\/form-data; boundary=/);
      assert.match(uploads[1].body.toString(), /filename="sample.wav"/);
      assert.match(uploads[1].body.toString(), /name="model_id"\r\n\r\nscribe_v2/);
      assert.ok(uploads[1].body.includes(audio));

      const controller = new AbortController();

      const cancelled = postRawAudioFile(new URL("/slow", url), filePath, "audio/wav", "test-key", {
        signal: controller.signal,
      });

      controller.abort();
      await assert.rejects(cancelled, { name: "AbortError" });
      console.log("audio file upload smoke passed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
