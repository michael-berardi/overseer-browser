/** Consent requests contain no pixels. One bounded recorder per extension. */
export function recordingOptions(p: Record<string, unknown>) {
  const integer = (key: string, fallback: number, max: number) => {
    const n = p[key] ?? fallback;
    if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > max) throw new Error(`Invalid ${key}`);
    return Number(n);
  };
  return { fps: integer('fps', 30, 60), seconds: integer('seconds', 60, 300), max_bytes: integer('max_bytes', 32 * 1024 * 1024, 64 * 1024 * 1024) };
}
export const RECORD_CHUNK = 192 * 1024;
