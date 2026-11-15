// The median every tool reports: the middle value, or the mean of the two
// middle values for an even count; null and NaN entries are skipped, and an
// empty list gives null.  The rounding hides float noise of that mean.
export const median = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const h = n >> 1;
  return n % 2 ? s[h] : +((s[h - 1] + s[h]) / 2).toPrecision(12);
};
