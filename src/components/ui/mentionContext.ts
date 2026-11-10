import { createContext } from "react";

export const MentionParticipantsContext = createContext<
  ReadonlyArray<{ contactId: number; email: string | null }>
>([]);
