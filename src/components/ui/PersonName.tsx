import { usePersonName } from "../../hooks/usePersonProfile";

/** A person's best-known name (see usePersonName), as plain text. */
export default function PersonName({
  email,
  contactId,
  inviteName,
}: {
  email: string | null;
  contactId?: number | null;
  inviteName?: string | null;
}) {
  return <>{usePersonName(email, inviteName, contactId)}</>;
}
