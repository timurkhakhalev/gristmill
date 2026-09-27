// @probe-name "an incomplete meeting coordinator dependency set fails compilation"
// @probe-codes [2322]
// @probe-origin test/scripts/meetingCoordinatorTypeProbe.test.js
import { registerMeetingCoordinatorHandlers, type IpcMainLike } from "./src/helpers/meetingCoordinatorIpcHandlers.js";

declare const ipcMain: IpcMainLike;

registerMeetingCoordinatorHandlers(ipcMain, {
  databaseManager: {},
  meetingDetectionEngine: null,
});
