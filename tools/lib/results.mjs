// Results file names that a parallel or same-minute run cannot overwrite, and
// that say what was run: the second and the pid, and the run's parts (dist,
// query, ...) made safe for one path component.
export const runStamp = () =>
  new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19) + "-" + process.pid;

export const slug = (s) =>
  String(s).replace(/[^A-Za-z0-9.,=+-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);

export const resultName = (tool, ...parts) =>
  [tool, ...parts.filter((p) => p !== undefined && p !== null && p !== "").map(slug), runStamp()].join("-");
