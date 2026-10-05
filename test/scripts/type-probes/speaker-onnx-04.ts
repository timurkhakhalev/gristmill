// @probe-name "speaker mapping results expose the profileId the handlers stamp"
// @probe-codes [2551]
// @probe-origin issue-281 IPC/DTO boundary package
import type { SpeakerApi } from "./src/contracts/speakerProfiles.js";

declare const api: SpeakerApi;

async function main() {
  const result = await api.setSpeakerMapping(1, "spk_0", "Name");

  // The result is success + profileId; a legacy profile row object must not
  // appear here.
  const profile: { id: number } | undefined = result.profile;
  void profile;
}
void main();
