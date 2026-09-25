const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-audio-upload-"));
app.setPath("userData", tempDir);

app
  .whenReady()
  .then(async () => {
    const { postRawAudioFile } = await import("../../src/helpers/audioFileUpload.ts");
    const filePath = path.join(tempDir, "sample.wav");
    const audio = Buffer.from("audio-file-payload");
    fs.writeFileSync(filePath, audio);
    const uploads = [];
    const server = http.createServer((request, response) => {
      if (request.url === "/slow") return;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        uploads.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = new URL(`http://127.0.0.1:${server.address().port}/upload`);
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
      assert.match(uploads[1].headers["content-type"], /^multipart\/form-data; boundary=/);
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
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tempDir, { recursive: true, force: true });
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
