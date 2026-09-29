const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

// LaunchServices makes Electron responsible for its TCC requests instead of
// inheriting the terminal's permissions. Keep terminal logs and Ctrl-C working.
function launchMacElectron(binary, args, env, spawnProcess = spawn) {
  const bundle = path.resolve(binary, "../../..");
  if (!bundle.endsWith(".app")) throw new Error("Expected an Electron.app executable");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-launch-"));
  const outputs = [process.stdout, process.stderr].map((stream, index) => {
    const file = path.join(directory, `${index}.log`);
    fs.writeFileSync(file, "", { mode: 0o600 });
    return { stream, file, offset: 0 };
  });
  const marker = `--gristmill-launch=${path.basename(directory)}`;
  // open passes its environment to a new app instance without exposing it in argv.
  const launchArgs = ["-n", "-W", "-a", bundle, "--stdout", outputs[0].file, "--stderr", outputs[1].file];
  launchArgs.push("--args", ...args, marker);
  const child = spawnProcess("/usr/bin/open", launchArgs, { stdio: "inherit", env });
  let stopping = false;
  let signalled = false;
  const flush = () => {
    for (const output of outputs) {
      const size = fs.statSync(output.file).size;
      if (size <= output.offset) continue;
      const fd = fs.openSync(output.file, "r");
      try {
        const buffer = Buffer.alloc(size - output.offset);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, output.offset);
        output.stream.write(buffer.subarray(0, bytes));
        output.offset += bytes;
      } finally { fs.closeSync(fd); }
    }
    if (stopping && !signalled) {
      const processes = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
      for (const line of processes.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match && match[2].startsWith(`${binary} `) && match[2].split(" ").includes(marker)) {
          try { process.kill(Number(match[1]), "SIGTERM"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          signalled = true;
        }
      }
    }
  };
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = setInterval(flush, 100);
  child.once("close", () => {
    clearInterval(timer);
    flush();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return child;
}

module.exports = { launchMacElectron };
