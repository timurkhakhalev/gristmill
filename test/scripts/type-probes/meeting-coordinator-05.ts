// @probe-name "production capture persistence rejects an incompatible finalization result"
// @probe-codes [2322]
import type { DatabaseManager } from "./src/helpers/database.js";
import type { MeetingCoordinatorDeps } from "./src/helpers/meetingCoordinatorIpcHandlers.js";

declare const database: DatabaseManager;
const rejected: MeetingCoordinatorDeps["databaseManager"] = {
  ...database,
  finalizeMeetingRecording: () => null,
};
void rejected;
