// The database filename and other channel-scoped choices must follow the
// resolved app channel (main.ts exports OPENHERCULES_CHANNEL before anything
// reads userData), not NODE_ENV: the packaged Dev app runs without
// NODE_ENV=development but shares the dev channel profile with pnpm dev, and
// the two modes must converge on the same database file.
export function isDevelopmentChannel(): boolean {
  return process.env.OPENHERCULES_CHANNEL === "development";
}
