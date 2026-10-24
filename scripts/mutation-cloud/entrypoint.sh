#!/bin/sh
set -eu
: "${MUTATION_TARGET:?required}"
: "${MUTATION_MODE:?required}"
: "${MUTATION_COMMIT:?required}"
: "${REPORTS_BUCKET:?required}"
: "${REPORTS_PREFIX:?required}"

upload_reports() {
  code=$?
  trap - EXIT
  # Upload to an execution-specific prefix; failed runs cannot replace earlier evidence.
  if ! node --input-type=module <<'JS'
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const directory = "reports/mutation";
const files = await readdir(directory, { recursive: true, withFileTypes: true }).catch(error => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
  headers: { "Metadata-Flavor": "Google" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Metadata request failed: ${response.status}`);
const credential = await response.json();
if (typeof credential.access_token !== "string") throw new Error("Missing access token");
for (const entry of files.filter(entry => entry.isFile())) {
  const file = path.join(entry.parentPath, entry.name);
  const name = `${process.env.REPORTS_PREFIX}/${process.env.CLOUD_RUN_EXECUTION}/${file}`;
  const upload = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(process.env.REPORTS_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.access_token}`, "Content-Type": "application/octet-stream" },
    body: await readFile(file),
    signal: AbortSignal.timeout(30_000),
  });
  if (!upload.ok) throw new Error(`Report upload failed: ${upload.status}`);
}
JS
  then
    echo "Report upload failed" >&2
    if [ "$code" -eq 0 ]; then code=1; fi
  fi
  exit "$code"
}
trap upload_reports EXIT
pnpm mutation --target "$MUTATION_TARGET" --mode "$MUTATION_MODE"
