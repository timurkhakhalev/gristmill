// Meeting-detection and contacts types. The calendar event, account, status
// and attendee DTO moved to the shared wire contract
// (src/contracts/calendar.ts) together with the calendar IPC boundary;
// provider ingestion types stay inside the managers.
export interface MeetingDetectionPreferences {
  processDetection: boolean;
  audioDetection: boolean;
}

export interface Contact {
  email: string;
  display_name: string | null;
}
