// Require a real dotted-quad before applying IPv4 private-range checks so
// public DNS names like "127.example.com" / "10.example.com" cannot bypass
// the HTTPS requirement via string-prefix matching.
//
// Defensive depth: WHATWG URL normalization expands and canonicalizes
// dotted-quad hostnames before they reach isSecureHttpEndpoint, so the
// malformed-quad guards below are unreachable through the public API. They
// stay for direct-call safety and are intentionally not exported for tests.
function parseIPv4Literal(hostname: string): number[] | null {
  const parts = hostname.split(".");

  if (parts.length !== 4) return null;

  const octets: number[] = [];

  for (const part of parts) {
    // Reject empty labels, leading zeros ("01"), and non-decimal forms.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);

    if (value > 255) return null;
    octets.push(value);
  }

  return octets;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0") return true;

  if (h === "::1") return true;

  const ipv4 = parseIPv4Literal(h);

  if (ipv4) {
    const [a, b] = ipv4;

    if (a === 127) return true;

    if (a === 10) return true;

    if (a === 192 && b === 168) return true;

    if (a === 172 && b >= 16 && b <= 31) return true;

    // RFC 6598 CGNAT (Tailscale): 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true;

    if (a === 169 && b === 254) return true;
  }

  const isIPv6 = h.includes(":");

  // Link-local is fe80::/10 (fe80–febf), not only the fe80 hextet. Same rule as
  // isPrivateIp in urlAudioDownloader.js. Unique local is fc00::/7 (fc/fd).
  if (isIPv6 && (/^fe[89ab]/.test(h) || h.startsWith("fc") || h.startsWith("fd"))) return true;

  if (h.endsWith(".local")) return true;

  // Tailscale MagicDNS — resolves to CGNAT (100.64/10) addresses reachable
  // only inside the user's own tailnet.
  if (h.endsWith(".ts.net")) return true;

  return false;
}

export function isSecureHttpEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isPrivateHost(parsed.hostname))
    );
  } catch {
    return false;
  }
}
