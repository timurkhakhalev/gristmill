// SAFETY: CJS require seam for Node's strip-only script loader.
const fs = require("node:fs") as typeof import("node:fs");

// SAFETY: CJS require seam for Node's strip-only script loader.
const path = require("node:path") as typeof import("node:path");

// SAFETY: CJS require seam for Node's strip-only script loader.
const crypto = require("node:crypto") as typeof import("node:crypto");

// SAFETY: CJS require seam for Node's strip-only script loader.
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

// SAFETY: CJS require seam for the cache manifest parser.
const { z } = require("zod") as typeof import("zod");

const version = "8.1.1";

const archiveName = `ffmpeg-${version}.tar.xz`;

const archiveUrl = `https://ffmpeg.org/releases/${archiveName}`;

// Measured from the upstream release archive, not from a locally modified source tree.
const checksum = "b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3";

const flags = [
  "--disable-everything",
  "--disable-autodetect",
  "--disable-programs",
  "--disable-doc",
  "--disable-network",
  "--disable-avcodec",
  "--disable-avformat",
  "--disable-avdevice",
  "--disable-avfilter",
  "--disable-swscale",
  "--enable-swresample",
  "--enable-avutil",
  "--enable-shared",
  "--disable-static",
  "--disable-gpl",
  "--disable-nonfree",
  "--disable-version3",
  "--disable-openssl",
  "--arch=arm64",
  "--target-os=darwin",
  "--cc=clang",
  "--extra-cflags=-arch arm64 -mmacosx-version-min=12.0",
  "--extra-ldflags=-arch arm64 -mmacosx-version-min=12.0",
  "--install-name-dir=@loader_path",
];

const outputs = ["meeting-resampler", "libswresample.6.dylib", "libavutil.60.dylib"];

const cacheOutputs = [...outputs, "build.json"];

const cacheHashesSchema = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/));

function hash(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

interface CacheOptions {
  cacheRoot: string;
  inputs: {
    checksum: string;
    flags: string[];
    compiler: string;
    architecture: string;
    deploymentTarget: string;
    helperHash: string;
    recipeHash: string;
    helperFlags: string[];
  };
  download: (destination: string) => void;
  build: (archive: string, directory: string) => void;
}

function cachedBuild(options: CacheOptions) {
  fs.mkdirSync(options.cacheRoot, { recursive: true });
  const archive = path.join(options.cacheRoot, archiveName);

  if (!fs.existsSync(archive) || hash(archive) !== options.inputs.checksum) {
    const temporary = `${archive}.download`;

    try {
      options.download(temporary);

      if (hash(temporary) !== options.inputs.checksum)
        throw new Error("Pinned FFmpeg source checksum mismatch");
      fs.renameSync(temporary, archive);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw new Error(
        `Meeting resampler build requires the verified pinned source archive; unavailable offline or download failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const key = crypto.createHash("sha256").update(JSON.stringify(options.inputs)).digest("hex");
  const directory = path.join(options.cacheRoot, key);
  const marker = path.join(directory, "verified.json");

  if (fs.existsSync(marker)) {
    try {
      const saved = cacheHashesSchema.parse(JSON.parse(fs.readFileSync(marker, "utf8")));

      if (cacheOutputs.every((name) => saved[name] === hash(path.join(directory, name))))
        return { directory, reused: true };
    } catch {
      /* Corrupt or incomplete outputs must rebuild. */
    }
  }

  const temporary = fs.mkdtempSync(path.join(options.cacheRoot, "build-"));

  try {
    options.build(archive, temporary);

    const hashes = Object.fromEntries(
      cacheOutputs.map((name) => [name, hash(path.join(temporary, name))])
    );

    fs.writeFileSync(path.join(temporary, "verified.json"), JSON.stringify(hashes));
    fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(temporary, directory);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  return { directory, reused: false };
}

function verifyMinimum(file: string) {
  const header = fs.readFileSync(file).subarray(0, 8);

  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c)
    throw new Error(`Meeting resampler is not arm64 Mach-O: ${file}`);
  const commands = execFileSync("otool", ["-l", file], { encoding: "utf8" });

  const minimums = [
    ...commands.matchAll(
      /cmd LC_(?:BUILD_VERSION[\s\S]*?minos|VERSION_MIN_MACOSX[\s\S]*?version)\s+(\d+)\.(\d+)(?:\.(\d+))?/g
    ),
  ];

  // LC_BUILD_VERSION uses minos; LC_VERSION_MIN_MACOSX uses version.
  if (
    !minimums.length ||
    minimums.some(
      (match) =>
        Number(match[1]) > 12 ||
        (Number(match[1]) === 12 && (Number(match[2]) > 0 || Number(match[3] ?? 0) > 0))
    )
  )
    throw new Error(`Meeting resampler minimum OS exceeds macOS 12.0: ${file}`);
}

function buildMeetingResampler(root: string) {
  if (process.platform !== "darwin") return;
  const source = path.join(root, "resources", "meeting-resampler.c");
  const compiler = execFileSync("clang", ["--version"], { encoding: "utf8" }).trim();

  const compilerArgs = [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-arch",
    "arm64",
    "-mmacosx-version-min=12.0",
  ];

  const inputs = {
    checksum,
    flags,
    compiler,
    architecture: "arm64",
    deploymentTarget: "12.0",
    helperHash: hash(source),
    recipeHash: hash(__filename),
    helperFlags: compilerArgs,
  };

  const commands: Array<{ command: string; args: string[] }> = [];

  const result = cachedBuild({
    cacheRoot: path.join(root, ".cache", "meeting-resampler-build"),
    inputs,
    download(destination) {
      console.log("[meeting-resampler] Downloading pinned FFmpeg source");
      execFileSync(
        "curl",
        ["--fail", "--location", "--retry", "2", archiveUrl, "-o", destination],
        { stdio: "inherit" }
      );
    },
    build(archive, directory) {
      const run = (command: string, args: string[], cwd?: string) => {
        commands.push({ command, args });
        execFileSync(command, args, { cwd, stdio: "inherit" });
      };

      run("tar", ["-xf", archive, "-C", directory]);
      const extracted = path.join(directory, `ffmpeg-${version}`);
      const prefix = path.join(directory, "installed");
      run(path.join(extracted, "configure"), [...flags, `--prefix=${prefix}`], extracted);
      run("make", ["-j4"], extracted);
      run("make", ["install"], extracted);

      for (const name of outputs.slice(1))
        fs.copyFileSync(path.join(prefix, "lib", name), path.join(directory, name));
      run("clang", [
        ...compilerArgs,
        source,
        `-I${path.join(prefix, "include")}`,
        `-L${path.join(prefix, "lib")}`,
        "-lswresample",
        "-lavutil",
        "-Wl,-rpath,@executable_path",
        "-o",
        path.join(directory, outputs[0]),
      ]);

      for (const name of outputs) verifyMinimum(path.join(directory, name));
      fs.writeFileSync(
        path.join(directory, "build.json"),
        JSON.stringify({ inputs, archiveUrl, commands }, null, 2)
      );
    },
  });

  console.log(
    `[meeting-resampler] ${result.reused ? "Reusing verified cache (no download/recompile)" : "Built pinned native helper"}`
  );
  const bin = path.join(root, "resources", "bin");
  fs.mkdirSync(bin, { recursive: true });

  for (const name of outputs) {
    const from = path.join(result.directory, name),
      to = path.join(bin, name);

    verifyMinimum(from);

    if (!fs.existsSync(to) || hash(to) !== hash(from)) fs.copyFileSync(from, to);
  }

  const licenses = path.join(root, "resources", "licenses", "meeting-resampler");
  fs.mkdirSync(licenses, { recursive: true });

  const copy = (from: string, name: string) => {
    const to = path.join(licenses, name);

    if (!fs.existsSync(to) || hash(to) !== hash(from)) fs.copyFileSync(from, to);
  };

  copy(path.join(root, ".cache", "meeting-resampler-build", archiveName), archiveName);
  copy(source, "meeting-resampler.c");
  copy(__filename, "build-meeting-resampler.cts");
  copy(path.join(result.directory, "build.json"), "build.json");

  const buildDetails = [
    `Archive: ${archiveUrl}`,
    `SHA-256: ${checksum}`,
    `Compiler: ${compiler}`,
    "",
    "Configure (replace SOURCE and PREFIX with your own paths):",
    "```sh",
    `SOURCE/configure ${flags.map((flag) => `'${flag}'`).join(" ")} --prefix=PREFIX`,
    "make -j4",
    "make install",
    "```",
    "",
    "Helper compiler:",
    "```sh",
    `clang ${compilerArgs.join(" ")} meeting-resampler.c -IPREFIX/include -LPREFIX/lib -lswresample -lavutil '-Wl,-rpath,@executable_path' -o meeting-resampler`,
    "```",
  ].join("\n");

  const instructions = fs
    .readFileSync(path.join(root, "resources", "meeting-resampler-BUILDING.md"), "utf8")
    .replace("{{BUILD_DETAILS}}", buildDetails);

  const building = path.join(licenses, "BUILDING.md");

  if (!fs.existsSync(building) || fs.readFileSync(building, "utf8") !== instructions)
    fs.writeFileSync(building, instructions);
}

const api = {
  buildMeetingResampler,
  cachedBuild,
  checksum,
  flags,
  archiveName,
  outputs,
  cacheOutputs,
};

module.exports = api;

export type API = typeof api;
