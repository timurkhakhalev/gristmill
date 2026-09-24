export function noteContentHash(content: string): string {
  return `${content.length}-${content.slice(0, 50)}`;
}
