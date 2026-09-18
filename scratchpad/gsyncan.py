#!/usr/bin/env python3
"""Read the GSYNC_* cause split out of a j2mebench --tracec log.

Split out of gsync.sh so a log can be re-read without re-running the
30-minute benchmark that produced it.
"""
import re, sys

CAUSE = [("gsyncSe",    "guest memory op / faulting op (semantics)"),
         ("gsyncCall",  "helper reading or writing env (semantics)"),
         ("gsyncCbr",   "conditional branch -- ARM predication (shape)"),
         ("gsyncBbend", "label or br (shape); goto_tb is BB_EXIT and charges "
                        "EXIT, not this"),
         ("gsyncExit",  "end of TB (shape, but the TB must end somewhere)")]

rows = []
for m in re.finditer(r"perMi:(.*)", open(sys.argv[1], errors="replace").read()):
    rows.append({k: float(v) for k, v in
                 re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", m.group(1))})
if not rows:
    sys.exit("no perMi lines -- did the leg run?")

for i, r in enumerate(rows):
    gst, gld, gen = r.get("tcgGst", 0.0), r.get("tcgGld", 0.0), r.get("tbGen", 0.0)
    icnt = r.get("tbIcount", 0.0)
    tot = sum(r.get(k, 0.0) for k, _ in CAUSE)
    if not gen or not gst or not icnt:
        print(f"leg{i}: tcgGst/tbGen/tbIcount is 0 -- counters missing")
        continue
    # tbIcount is the SUM of tb->icount over translated TBs (wasm-diag.h:112),
    # not a mean, and every perMi value shares the same denominator.  So mean
    # TB length is icnt/gen, and a per-guest-instruction rate is x/icnt --
    # never x/gen/icnt, which divides by the TB count twice.
    tblen = icnt / gen
    print(f"\nleg{i}: {gst/gen:.2f} stores and {gld/gen:.2f} loads per TB "
          f"over {tblen:.2f} guest insns = "
          f"{(gst+gld)/icnt:.2f} env memory ops per guest instruction")
    # The GSYNC_* counters and TCG_GST count two different populations, so
    # the shares below are taken against the GSYNC total, never against
    # TCG_GST.  la_charge fires once per global output arg that liveness
    # marks SYNC_ARG -- a sync *demand*; TCG_GST fires in temp_sync, which
    # emits nothing when the global is already coherent.  Demands therefore
    # exceed stores (~1.33x here), which is why dividing a cause by TCG_GST
    # used to print an "attributed 135% of the stores" that no residue can
    # explain.  A cause's share of the demands is still the right lever size:
    # removing d demands removes d * (stores/demands) stores, and dividing
    # that by gst gives back d/tot.
    print(f"   {tot:.3f} sync demands per Mi against {gst:.3f} emitted "
          f"stores ({tot/gst:.2f} demands per store)")
    for k, what in CAUSE:
        v = r.get(k, 0.0)
        print(f"   {k:<12}{v/gen:7.2f}/TB  {v/tot*100:5.1f}%  {what}")
    shape = sum(r.get(k, 0.0) for k in ("gsyncCbr", "gsyncBbend"))
    print(f"   removable ceiling (CBR+BBEND): {shape/tot*100:.1f}% of the "
          f"demands = {shape/icnt:.3f} per guest instruction")

    pred, sel = r.get("predA32", 0.0), r.get("predSel", 0.0)
    if pred:
        print(f"   A32 predication: {pred/gen:.2f}/TB = {pred/icnt*100:.1f}% "
              f"of translated instructions, {sel/pred*100:.1f}% of them a "
              f"shape movcond could take")
        # A predicated A32 insn emits *two* boundaries and they charge
        # different counters: the brcond-over-itself claims globals dirtied
        # before it (CBR), the label after it claims the insn's own outputs
        # (BBEND), because tcg.c clears TS_MEM at every write and so restarts
        # the blame span.  CBR alone is therefore the half if-conversion does
        # NOT remove -- a floor, not a ceiling.  The true value sits between
        # it and the case where every BBEND is a condlabel; BBEND does not yet
        # distinguish a condlabel from a br or any other label.
        cbr, bbend = r.get("gsyncCbr", 0.0), r.get("gsyncBbend", 0.0)
        lo, hi = cbr * sel / pred, (cbr + bbend) * sel / pred
        print(f"   so branchless predication is worth between "
              f"{lo/tot*100:.2f}% and {hi/tot*100:.1f}% of the write-backs "
              f"(floor = CBR only; roof = all of BBEND is condlabels)")
