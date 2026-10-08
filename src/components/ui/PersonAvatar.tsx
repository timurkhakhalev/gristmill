import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { usePersonProfile } from "../../hooks/usePersonProfile";
import { runInBackground } from "../../stores/noteStore";

function getInitial(displayName: string | null, email: string | null): string {
  return (displayName || email || "?").charAt(0).toUpperCase();
}

function getInitialColor(seed: string): string {
  let hash = 0;

  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }

  return `hsl(${Math.abs(hash) % 360}, 45%, 65%)`;
}

// Shared across mounts so a remounted avatar paints its final state at once
// instead of initial → hash lookup → Gravatar 404 → initial again.
const hashByEmail = new Map<string, string>();

const failedImageUrls = new Set<string>();

interface PersonAvatarProps {
  email: string | null;
  displayName: string | null;
  /** Diameter in px. */
  size?: number;
  className?: string;
}

/** The person's Google photo, else their Gravatar, else a colored initial. */
export default function PersonAvatar({
  email,
  displayName,
  size = 24,
  className,
}: PersonAvatarProps) {
  const profile = usePersonProfile(email);
  const photoUrl = profile?.photo_url ?? null;

  const [hash, setHash] = useState<string | null>(() =>
    email ? (hashByEmail.get(email) ?? null) : null
  );

  useEffect(() => {
    const cached = email ? (hashByEmail.get(email) ?? null) : null;
    setHash(cached);

    if (!email || cached) return;
    let cancelled = false;
    runInBackground(
      window.electronAPI?.getMD5Hash?.(email).then((result) => {
        if (result) hashByEmail.set(email, result);

        if (!cancelled) setHash(result);
      }),
      "Avatar hash failed"
    );

    return () => {
      cancelled = true;
    };
  }, [email]);

  const gravatarUrl = hash
    ? `https://www.gravatar.com/avatar/${hash}?d=404&s=${Math.min(512, size * 2)}`
    : null;

  const [, rerender] = useState(0);

  const markFailed = (url: string) => {
    failedImageUrls.add(url);
    rerender((n) => n + 1);
  };

  if (photoUrl && !failedImageUrls.has(photoUrl)) {
    return (
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
        onError={() => markFailed(photoUrl)}
      />
    );
  }

  if (gravatarUrl && !failedImageUrls.has(gravatarUrl)) {
    return (
      <img
        src={gravatarUrl}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
        onError={() => markFailed(gravatarUrl)}
      />
    );
  }

  return (
    <span
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.42)),
        backgroundColor: getInitialColor(email || displayName || "?"),
      }}
      className={cn(
        "shrink-0 rounded-full flex items-center justify-center font-medium text-white",
        className
      )}
    >
      {getInitial(profile?.display_name || displayName, email)}
    </span>
  );
}
