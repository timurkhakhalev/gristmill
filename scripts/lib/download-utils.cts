export interface Release {
  tag: string;
  url: string;
  assets: { name: string; url: string }[];
}
interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string }[];
}
const https: typeof import("https") = require("https");
const fs: typeof import("fs") = require("fs");
const path: typeof import("path") = require("path");
const { execFileSync }: typeof import("child_process") = require("child_process");

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_REDIRECTS = 5;

/**
 * Fetch JSON from a URL with proper error handling.
 * @param {string} url - URL to fetch
 * @param {number} [redirectCount=0] - Current redirect count (internal use)
 * @returns {Promise<object>} - Parsed JSON response
 */
function fetchJson<T>(url: string, redirectCount = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const headers: Record<string, string> = {
      "User-Agent": "Gristmill-Downloader",
      Accept: "application/vnd.github+json",
    };

    // Use GitHub token if available (increases rate limit from 60 to 5000/hour)
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      headers,
      timeout: REQUEST_TIMEOUT,
    };

    https
      .get(url, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error("Redirect without location header"));
            return;
          }
          const redirectUrl = location.startsWith("/") ? new URL(location, url).href : location;
          fetchJson<T>(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(
              new Error(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`)
            );
          }
        });
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Request timeout")));
  });
}

/**
 * Fetch a release from a GitHub repository.
 * @param {string} repo - Repository in "owner/repo" format
 * @param {object} options - Options
 * @param {string} [options.tag] - Exact tag to fetch (works for any release age, no pagination)
 * @param {string} [options.tagPrefix] - Latest release whose tag starts with this prefix (searches the 50 most recent only)
 * @param {boolean} [options.includePrerelease=false] - Include prereleases (tagPrefix only)
 * @returns {Promise<{tag: string, assets: Array<{name: string, url: string}>, url: string} | null>}
 */
async function fetchLatestRelease(
  repo: string,
  options: { tag?: string; tagPrefix?: string; includePrerelease?: boolean } = {}
): Promise<Release | null> {
  const { tag, tagPrefix, includePrerelease = false } = options;

  try {
    if (tag) {
      const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
      const release = await fetchJson<GitHubRelease>(url);
      return formatRelease(release);
    }

    if (!tagPrefix) {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const release = await fetchJson<GitHubRelease>(url);
      return formatRelease(release);
    }

    const url = `https://api.github.com/repos/${repo}/releases?per_page=50`;
    const releases = await fetchJson<GitHubRelease[]>(url);

    if (!Array.isArray(releases)) {
      return null;
    }

    // Find the latest release matching the prefix
    for (const release of releases) {
      if (release.draft) continue;
      if (!includePrerelease && release.prerelease) continue;
      if (release.tag_name && release.tag_name.startsWith(tagPrefix)) {
        return formatRelease(release);
      }
    }

    return null;
  } catch (error) {
    console.error(
      `  Failed to fetch latest release for ${repo}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Format a GitHub release response into a simplified object.
 * @param {object} release - GitHub release API response
 * @returns {{tag: string, assets: Array<{name: string, url: string}>, url: string}}
 */
function formatRelease(release: GitHubRelease): Release {
  return {
    tag: release.tag_name,
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadFile(url: string, dest: string, retryCount = 0): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let activeRequest: import("node:http").ClientRequest | null = null;

    const cleanup = () => {
      if (activeRequest) {
        activeRequest.destroy();
        activeRequest = null;
      }
      file.close();
    };

    const request = (currentUrl: string, redirectCount = 0) => {
      if (redirectCount > MAX_REDIRECTS) {
        cleanup();
        reject(new Error("Too many redirects"));
        return;
      }

      activeRequest = https.get(currentUrl, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          const location = response.headers.location;
          if (!location) {
            cleanup();
            reject(new Error("Redirect without location header"));
            return;
          }
          const redirectUrl = location.startsWith("/")
            ? new URL(location, currentUrl).href
            : location;
          // Drain the old response so redirects cannot keep a completed CLI alive.
          response.resume();
          activeRequest?.setTimeout(0);
          request(redirectUrl, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers["content-length"] ?? "", 10);
        let downloaded = 0;

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          const pct = total ? Math.round((downloaded / total) * 100) : 0;
          process.stdout.write(`\r  Downloading: ${pct}%`);
        });

        response.on("error", (err) => {
          cleanup();
          reject(err);
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log(" Done");
          resolve();
        });

        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      activeRequest.on("error", (err) => {
        cleanup();
        reject(err);
      });

      activeRequest.setTimeout(REQUEST_TIMEOUT, () => {
        cleanup();
        reject(new Error("Connection timed out"));
      });
    };

    request(url);
  }).catch(async (error) => {
    const isTransient =
      (error instanceof Error ? error.message : String(error)).includes("timed out") ||
      (error as NodeJS.ErrnoException).code === "ECONNRESET" ||
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT";

    if (isTransient && retryCount < MAX_RETRIES) {
      console.log(
        `\n  Retry ${retryCount + 1}/${MAX_RETRIES}: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(RETRY_DELAY);
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      return downloadFile(url, dest, retryCount + 1);
    }
    throw error;
  });
}

async function extractZip(zipPath: string, destDir: string) {
  execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
}

function extractTarGz(tarPath: string, destDir: string) {
  execFileSync("tar", ["-xzf", tarPath, "-C", destDir], { stdio: "inherit" });
}

async function extractArchive(archivePath: string, destDir: string) {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    extractTarGz(archivePath, destDir);
  } else {
    await extractZip(archivePath, destDir);
  }
}

function findBinaryInDir(
  dir: string,
  binaryName: string,
  maxDepth = 5,
  currentDepth = 0
): string | null {
  if (currentDepth >= maxDepth) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName, maxDepth, currentDepth + 1);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return fullPath;
    }
  }

  return null;
}

function parseArgs() {
  const args = process.argv;
  let targetPlatform = process.env.TARGET_PLATFORM || process.platform;
  let targetArch = process.env.TARGET_ARCH || process.arch;

  // CLI args override env vars
  const platformIndex = args.indexOf("--platform");
  if (platformIndex !== -1 && args[platformIndex + 1]) {
    targetPlatform = args[platformIndex + 1];
  }

  const archIndex = args.indexOf("--arch");
  if (archIndex !== -1 && args[archIndex + 1]) {
    targetArch = args[archIndex + 1];
  }

  return {
    targetPlatform,
    targetArch,
    platformArch: `${targetPlatform}-${targetArch}`,
    isCurrent: args.includes("--current"),
    isAll: args.includes("--all"),
    isForce: args.includes("--force"),
    shouldCleanup:
      args.includes("--clean") ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true",
  };
}

function setExecutable(filePath: string) {
  fs.chmodSync(filePath, 0o755);
}

function matchesPattern(filename: string, pattern: string) {
  if (pattern === "*.dylib") {
    return filename.endsWith(".dylib");
  } else if (pattern === "*.dll") {
    return filename.endsWith(".dll");
  } else if (pattern === "*.so*") {
    return /\.so(\.\d+)*$/.test(filename) || filename.endsWith(".so");
  }
  return false;
}

function findLibrariesInDir(
  dir: string,
  pattern: string,
  options: { maxDepth?: number; ignoreReadErrors?: boolean } = {},
  currentDepth = 0
): string[] {
  const { maxDepth = 5, ignoreReadErrors = false } = options;
  if (currentDepth >= maxDepth) return [];

  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (ignoreReadErrors) return [];
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findLibrariesInDir(fullPath, pattern, options, currentDepth + 1));
    } else if (matchesPattern(entry.name, pattern)) {
      results.push(fullPath);
    }
  }

  return results;
}

function copyLibraries(extractDir: string, destDir: string, pattern: string) {
  const copied = [];
  for (const libPath of findLibrariesInDir(extractDir, pattern)) {
    const libName = path.basename(libPath);
    const destPath = path.join(destDir, libName);
    fs.copyFileSync(libPath, destPath);
    setExecutable(destPath);
    copied.push(libName);
  }
  return copied;
}

function cleanupFiles(binDir: string, prefix: string, keepPrefix: string | string[]) {
  const keepPrefixes = Array.isArray(keepPrefix) ? keepPrefix : [keepPrefix];
  // Never delete shared libraries; only platform binaries. The b9763 split ships
  // llama-server-impl.dll, which shares the "llama-server" prefix and must survive.
  const isLibrary = (f: string) => /\.(dll|dylib)$/i.test(f) || /\.so(\.\d+)*$/.test(f);
  const files = fs.readdirSync(binDir).filter((f) => f.startsWith(prefix));
  files.forEach((file) => {
    if (!keepPrefixes.some((keep) => file.startsWith(keep)) && !isLibrary(file)) {
      const filePath = path.join(binDir, file);
      console.log(`Removing old binary: ${file}`);
      fs.unlinkSync(filePath);
    }
  });
}

const api = {
  copyLibraries,
  downloadFile,
  extractArchive,
  extractZip,
  fetchLatestRelease,
  findBinaryInDir,
  findLibrariesInDir,
  matchesPattern,
  parseArgs,
  setExecutable,
  cleanupFiles,
};

module.exports = api;
export type API = typeof api;
