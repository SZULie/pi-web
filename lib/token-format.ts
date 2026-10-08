export function parseTokenAmount(input: string | number): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  }
  const str = String(input || "").trim().toLowerCase();
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    const val = parseInt(str, 10);
    return val > 0 ? val : null;
  }
  const match = str.match(/^([\d.]+)\s*([km]?)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = match[2];
  if (unit === "k") return Math.round(num * 1000);
  if (unit === "m") return Math.round(num * 1000000);
  return Math.round(num);
}
