import { shell } from "electron";

export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);

  return shell.openExternal(parsed.href);
}
