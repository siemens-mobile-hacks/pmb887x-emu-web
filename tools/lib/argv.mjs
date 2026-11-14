// `--name value` options: the value after the flag, or the default when the
// flag is absent, last, or given an empty value.
export function opt(argv, name, dflt) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
