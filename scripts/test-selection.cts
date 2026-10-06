export interface RegistryGroup {
  domains: string[];
  kind: string;
  buildMain: boolean;
  serial?: boolean;
  files: string[];
}

// Raw shape read from test/test-groups.json before validation. Every field is
// unknown: the JSON is external input, so createPlan parses it into
// RegistryGroup only after the guard below checks each field.
interface RawRegistryGroup {
  domains?: unknown;
  kind?: unknown;
  buildMain?: unknown;
  serial?: unknown;
  files?: unknown;
}

export interface TestEntry {
  file: string;
  domains: string[];
  kind: string;
  buildMain: boolean;
  serial: boolean;
}

export interface Options {
  domains: string[];
  kinds: string[];
  files: string[];
  list: boolean;
  help: boolean;
  verbose: boolean;
  processes: number;
}

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const fs = require("node:fs") as typeof import("node:fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

const DOMAINS = ["notes", "recording", "transcription", "calendar", "ai", "settings", "platform"];

const KINDS = ["unit", "integration", "types", "native"];

const root = path.resolve(__dirname, "..");

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}

function isRegistryGroup(value: unknown): value is RegistryGroup {
  if (typeof value !== "object" || value === null) return false;

  // SAFETY: JSON.parse output; the guard below reads only RawRegistryGroup's
  // declared keys, and each is validated before RegistryGroup is exposed.
  const group = value as RawRegistryGroup;

  return (
    isStringArray(group.domains) &&
    group.domains.length > 0 &&
    new Set(group.domains).size === group.domains.length &&
    group.domains.every((domain) => DOMAINS.includes(domain)) &&
    isString(group.kind) &&
    KINDS.includes(group.kind) &&
    isBoolean(group.buildMain) &&
    (group.serial === undefined || isBoolean(group.serial)) &&
    isStringArray(group.files) &&
    group.files.length > 0
  );
}

function discoverTests(directory = root) {
  const files: string[] = [];

  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) visit(file);
      else if (/\.test\.(js|ts)$/.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Test must be an ordinary file: ${file}`);
        files.push(path.relative(directory, file).split(path.sep).join("/"));
      }
    }
  }

  visit(path.join(directory, "test"));

  return files.sort();
}

function validateRegistry(files: string[], groups: unknown[]): TestEntry[] {
  const assigned = new Map<string, TestEntry>();
  const knownFiles = new Set(files);

  for (const raw of groups) {
    if (!isRegistryGroup(raw)) throw new Error(`Invalid test group: ${JSON.stringify(raw)}`);

    const group = raw;

    for (const pattern of group.files) {
      if (
        !pattern.startsWith("test/") ||
        pattern.split("/").includes("..") ||
        !/\.test\.(js|ts)$/.test(pattern)
      ) {
        throw new Error(`Invalid test path: ${pattern}`);
      }

      const matches = knownFiles.has(pattern)
        ? [pattern]
        : files.filter((file) => path.matchesGlob(file, pattern));

      if (!matches.length) throw new Error(`Stale test registration: ${pattern}`);

      for (const file of matches) {
        if (assigned.has(file)) throw new Error(`Duplicate test registration: ${file}`);
        assigned.set(file, {
          file,
          domains: group.domains,
          kind: group.kind,
          buildMain: group.buildMain,
          serial: group.serial === true,
        });
      }
    }
  }

  const missing = [];

  for (const file of files) {
    if (assigned.has(file)) continue;
    const parts = file.split("/");

    if (
      parts.length >= 5 &&
      parts[0] === "test" &&
      parts[1] === "cases" &&
      DOMAINS.includes(parts[2]) &&
      KINDS.includes(parts[3])
    ) {
      const directories = parts.slice(4, -1);
      assigned.set(file, {
        file,
        domains: [parts[2]],
        kind: parts[3],
        buildMain: directories.includes("main"),
        serial: directories.includes("serial"),
      });
    } else missing.push(file);
  }

  if (missing.length)
    throw new Error(
      `Unclassified tests (put new tests under test/cases/<domain>/<kind>/):\n${missing.join("\n")}`
    );

  return files.map((file) => {
    const entry = assigned.get(file);

    if (entry === undefined) throw new Error(`Unclassified test: ${file}`);

    return entry;
  });
}

function parseArgs(input: string[]) {
  const args = [...input];

  if (args[0] === "--") args.shift();

  const result: Options = {
    domains: [],
    kinds: [],
    files: [],
    list: false,
    help: false,
    verbose: false,
    processes: 2,
  };

  while (args.length) {
    const arg = args.shift();

    if (arg === undefined) break;

    if (arg === "--list") result.list = true;
    else if (arg === "--help") result.help = true;
    else if (arg === "--verbose") result.verbose = true;
    else if (arg === "--processes") {
      const value = args.shift();

      if (value !== "1" && value !== "2")
        throw new Error(`--processes expects 1 or 2; received ${value ?? "no value"}`);
      result.processes = Number(value);
    } else if (arg === "--domain" || arg === "--kind") {
      const value = args.shift();
      const choices = arg === "--domain" ? DOMAINS : KINDS;

      if (!value || !choices.includes(value))
        throw new Error(
          `${arg} expects one of: ${choices.join(", ")}; received ${value ?? "no value"}`
        );
      result[arg === "--domain" ? "domains" : "kinds"].push(value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown test option: ${arg}`);
    else result.files.push(arg);
  }

  if (result.files.length && (result.domains.length || result.kinds.length)) {
    throw new Error("Choose explicit files OR domain/kind selectors, not both");
  }

  return result;
}

function selectTests(entries: TestEntry[], options: Options) {
  const requested = new Set(options.files);

  for (const file of requested) {
    if (!entries.some((entry) => entry.file === file))
      throw new Error(`Unknown test file: ${file}`);
  }

  const tests = entries.filter(
    (entry) =>
      (!requested.size || requested.has(entry.file)) &&
      (!options.domains.length ||
        options.domains.some((domain) => entry.domains.includes(domain))) &&
      (!options.kinds.length || options.kinds.includes(entry.kind))
  );

  if (!tests.length) throw new Error("No tests match this selection");

  return { tests, buildMain: tests.some((test) => test.buildMain) };
}

function createPlan(args: string[], directory = root) {
  const options = parseArgs(args);

  if (options.help) return { options, tests: [], buildMain: false };

  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(directory, "test/test-groups.json"), "utf8")
  );

  if (!Array.isArray(parsed)) throw new Error("test/test-groups.json must be an array");

  const entries = validateRegistry(discoverTests(directory), parsed);

  return { options, ...selectTests(entries, options) };
}

const api = { DOMAINS, KINDS, discoverTests, validateRegistry, parseArgs, selectTests, createPlan };

module.exports = api;

export type API = typeof api;
