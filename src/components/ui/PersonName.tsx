import { usePersonName } from "../../hooks/usePersonProfile";

/** A person's best-known name (see usePersonName), as plain text. */
export default function PersonName({ email, inviteName }: { email: string; inviteName?: string | null }) {
  return <>{usePersonName(email, inviteName)}</>;
}
