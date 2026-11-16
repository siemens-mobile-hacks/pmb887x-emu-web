// Command-line options: `--name value`, or `--name` alone for a flag.
// A tool names every option it takes; any other `--` argument, an option
// with no value after it, or more bare arguments than the tool takes is a
// usage error (exit 2), so a mistyped option never runs the default.
//
//   const args = parseArgs(process.argv.slice(2), {
//     values: ["dist", "secs"], flags: ["keep"], positional: 0,
//     usage: "node tools/x.mjs [--dist d] [--secs s] [--keep]",
//   });
//   args.opt("dist", "dist")   the value, or the default when the option
//                                  is absent or given an empty value
//   args.flag("keep")              whether the flag was given
//   args.positional                the bare arguments, in order
export function parseArgs(argv, { values = [], flags = [], positional = 0, usage = "" } = {}) {
  const fail = (msg) => {
    console.error(msg + (usage ? `\nusage: ${usage}` : ""));
    process.exit(2);
  };
  const got = new Map();
  const bare = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      bare.push(a);
      continue;
    }
    const name = a.slice(2);
    if (flags.includes(name)) {
      got.set(name, true);
    } else if (values.includes(name)) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      got.set(name, argv[++i]);
    } else {
      const known = [...values, ...flags].map((n) => "--" + n).join(", ");
      fail(`unknown option ${a}` + (known ? ` (known: ${known})` : " (this tool takes no options)"));
    }
  }
  if (bare.length > positional) fail(`unexpected argument: ${bare[positional]}`);
  return {
    opt(name, dflt) {
      if (!values.includes(name)) throw new Error(`--${name} is not one of this tool's options`);
      const v = got.get(name);
      return v === undefined || v === "" ? dflt : v;
    },
    flag(name) {
      if (!flags.includes(name)) throw new Error(`--${name} is not one of this tool's flags`);
      return got.has(name);
    },
    positional: bare,
  };
}
