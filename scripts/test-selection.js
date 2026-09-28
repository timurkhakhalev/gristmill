const fs = require("node:fs");
const path = require("node:path");

const DOMAINS = ["notes", "recording", "transcription", "calendar", "ai", "settings", "platform"];
const KINDS = ["unit", "integration", "types", "native"];
const root = path.resolve(__dirname, "..");

function discoverTests(directory = root) {
  const files = [];
  function visit(dir) {
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

function validateRegistry(files, groups) {
  const assigned = new Map();
  const knownFiles = new Set(files);
  for (const group of groups) {
    if (!Array.isArray(group.domains) || !group.domains.length ||
        new Set(group.domains).size !== group.domains.length ||
        group.domains.some((domain) => !DOMAINS.includes(domain)) ||
        !KINDS.includes(group.kind) || typeof group.buildMain !== "boolean" ||
        (group.serial !== undefined && typeof group.serial !== "boolean") ||
        !Array.isArray(group.files) || !group.files.length) {
      throw new Error(`Invalid test group: ${JSON.stringify(group)}`);
    }
    for (const pattern of group.files) {
      if (typeof pattern !== "string" || !pattern.startsWith("test/") ||
          pattern.split("/").includes("..") || !/\.test\.(js|ts)$/.test(pattern)) {
        throw new Error(`Invalid test path: ${pattern}`);
      }
      const matches = knownFiles.has(pattern) ? [pattern] : files.filter((file) => path.matchesGlob(file, pattern));
      if (!matches.length) throw new Error(`Stale test registration: ${pattern}`);
      for (const file of matches) {
        if (assigned.has(file)) throw new Error(`Duplicate test registration: ${file}`);
        assigned.set(file, { file, domains: group.domains, kind: group.kind, buildMain: group.buildMain, serial: group.serial === true });
      }
    }
  }
  const missing = [];
  for (const file of files) {
    if (assigned.has(file)) continue;
    const parts = file.split("/");
    if (parts.length >= 5 && parts[0] === "test" && parts[1] === "cases" &&
        DOMAINS.includes(parts[2]) && KINDS.includes(parts[3])) {
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
  if (missing.length) throw new Error(`Unclassified tests (put new tests under test/cases/<domain>/<kind>/):\n${missing.join("\n")}`);
  return files.map((file) => assigned.get(file));
}

function parseArgs(input) {
  const args = [...input];
  if (args[0] === "--") args.shift();
  const result = { domains: [], kinds: [], files: [], list: false, help: false, verbose: false, processes: 2 };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--list") result.list = true;
    else if (arg === "--help") result.help = true;
    else if (arg === "--verbose") result.verbose = true;
    else if (arg === "--processes") {
      const value = args.shift();
      if (value !== "1" && value !== "2") throw new Error(`--processes expects 1 or 2; received ${value ?? "no value"}`);
      result.processes = Number(value);
    }
    else if (arg === "--domain" || arg === "--kind") {
      const value = args.shift();
      const choices = arg === "--domain" ? DOMAINS : KINDS;
      if (!choices.includes(value)) throw new Error(`${arg} expects one of: ${choices.join(", ")}; received ${value ?? "no value"}`);
      result[arg === "--domain" ? "domains" : "kinds"].push(value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown test option: ${arg}`);
    else result.files.push(arg);
  }
  if (result.files.length && (result.domains.length || result.kinds.length)) {
    throw new Error("Choose explicit files OR domain/kind selectors, not both");
  }
  return result;
}

function selectTests(entries, options) {
  const requested = new Set(options.files);
  for (const file of requested) {
    if (!entries.some((entry) => entry.file === file)) throw new Error(`Unknown test file: ${file}`);
  }
  const tests = entries.filter((entry) =>
    (!requested.size || requested.has(entry.file)) &&
    (!options.domains.length || options.domains.some((domain) => entry.domains.includes(domain))) &&
    (!options.kinds.length || options.kinds.includes(entry.kind))
  );
  if (!tests.length) throw new Error("No tests match this selection");
  return { tests, buildMain: tests.some((test) => test.buildMain) };
}

function createPlan(args, directory = root) {
  const options = parseArgs(args);
  if (options.help) return { options };
  const groups = JSON.parse(fs.readFileSync(path.join(directory, "test/test-groups.json"), "utf8"));
  const entries = validateRegistry(discoverTests(directory), groups);
  return { options, ...selectTests(entries, options) };
}

module.exports = { DOMAINS, KINDS, discoverTests, validateRegistry, parseArgs, selectTests, createPlan };
