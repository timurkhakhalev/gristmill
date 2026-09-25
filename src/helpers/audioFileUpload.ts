import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";

export async function postRawAudioFile(
  url: URL,
  filePath: string,
  contentType: string,
  apiKey: string,
  {
    signal,
    multipart,
  }: {
    signal?: AbortSignal;
    multipart?: { fileName: string; fields: Record<string, string> };
  } = {}
): Promise<{ statusCode: number; data: unknown }> {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const boundary = multipart ? `----OpenHercules${crypto.randomUUID()}` : null;
  const header = multipart
    ? Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${multipart.fileName.replace(/[\r\n"]/g, "_")}"\r\nContent-Type: ${contentType}\r\n\r\n`
      )
    : null;
  const footer = multipart
    ? Buffer.from(
        `\r\n${Object.entries(multipart.fields)
          .map(
            ([name, value]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
          )
          .join("")}--${boundary}--\r\n`
      )
    : null;
  const size =
    (await fs.promises.stat(filePath)).size + (header?.length ?? 0) + (footer?.length ?? 0);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const source = fs.createReadStream(filePath);
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          ...(multipart
            ? { "xi-api-key": apiKey, "Content-Type": `multipart/form-data; boundary=${boundary}` }
            : { Authorization: `Token ${apiKey}`, "Content-Type": contentType }),
          "Content-Length": String(size),
        },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", finish);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let data: unknown = text;
          try {
            data = JSON.parse(text);
          } catch {
            // Keep non-JSON provider errors for the caller.
          }
          finish(undefined, { statusCode: response.statusCode ?? 0, data });
        });
      }
    );
    let settled = false;
    const finish = (error?: Error, result?: { statusCode: number; data: unknown }) => {
      if (settled) return;
      settled = true;
      source.destroy();
      request.destroy();
      if (error) reject(signal?.aborted ? new DOMException("Cancelled", "AbortError") : error);
      else if (result) resolve(result);
    };
    request.on("error", finish);
    request.on("close", () => {
      if (!settled) finish(new Error("Audio upload closed before a response"));
    });
    if (header) request.write(header);
    void pipeline(source, request, { end: false, signal })
      .then(() => {
        if (!settled) request.end(footer ?? undefined);
      })
      .catch(finish);
  });
}
