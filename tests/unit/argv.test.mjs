import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const helper = new URL("../../tools/lib/argv.mjs", import.meta.url).href;

// parseArgs exits on a usage error, so each case runs in a child of its own
function parse(argv, spec) {
  const script = `const { parseArgs } = await import(${JSON.stringify(helper)});
    const a = parseArgs(${JSON.stringify(argv)}, ${JSON.stringify(spec)});
    console.log(JSON.stringify({ dist: a.opt("dist", "dflt"), keep: a.flag("keep"), pos: a.positional }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  return { status: r.status, out: r.status === 0 ? JSON.parse(r.stdout) : null, err: r.stderr };
}

const spec = { values: ["dist"], flags: ["keep"], positional: 1 };

test("argv: known options, flags and the bare arguments", () => {
  assert.deepEqual(parse(["--dist", "dist-x", "--keep", "a"], spec).out,
    { dist: "dist-x", keep: true, pos: ["a"] });
  assert.deepEqual(parse([], spec).out, { dist: "dflt", keep: false, pos: [] });
  // an empty value takes the default, as before
  assert.deepEqual(parse(["--dist", ""], spec).out, { dist: "dflt", keep: false, pos: [] });
});

test("argv: an unknown option, a missing value or a stray argument exits 2", () => {
  const unknown = parse(["--flash", "s75"], spec);
  assert.equal(unknown.status, 2);
  assert.match(unknown.err, /unknown option --flash \(known: --dist, --keep\)/);
  assert.equal(parse(["--dist"], spec).status, 2);
  assert.equal(parse(["a", "b"], spec).status, 2);
});
