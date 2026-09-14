const { getOwnProcessPids } = require("./ownProcessPids");

// The macOS audio tap helper is a plain child process, so it never appears in the Electron
// process tree — yet the OS attributes their capture to their own pids.
// Without excluding them, the app's own system-audio capture reads as an
// external mic user and auto-end can never arm its end detection.
function collectAudioCaptureHelperPids(managers) {
  return managers
    .map((manager) => manager?.process?.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// Every pid whose mic use is OpenHercules' own: the Electron process tree plus
// any live capture helper. Evaluated on each call so helpers are covered from
// the moment they spawn and drop out when they exit.
function createExcludedProcessIdProvider(
  getAudioCaptureHelperPids = () => [],
  getOwnPids = getOwnProcessPids
) {
  return () => [...getOwnPids(), ...getAudioCaptureHelperPids()];
}

module.exports = { collectAudioCaptureHelperPids, createExcludedProcessIdProvider };
