# Memory card (disk 4:)

The card stack is upstream's (smh/master, merged at 827e5a7e62):
- `qemu/hw/arm/pmb887x/mci.c` (device `pmb887x-mci`), the PL180 MCI at F7301000, IRQ 148, with a "CARD" port;
- `qemu/hw/sd/sd-slot.c` (`sd-slot`), the board's slot: `[peripheral.SD_SLOT] type = "sd-slot"
  port = { card = "MCI:CARD" }` in the board TOML (bsp), with `out = { cd = "MMC_CD" }` where the phone has a
  card-detect pin. Its bool property `inserted` takes the card out of the port and puts it back;
- qemu's own `sd-card` behind it, on the drive `-drive if=sd` (id `sd0`).

Boards with a slot: the SG2 ELKA and X75 families (EL71, E71, M72, S75, SL75, C81, M81, S68), CL61/CL61A, SL98, LG KE800/KE970,
Panasonic 705P. Other boards refuse an `if=sd` drive ("no slot takes it"), and the page and `run-native.sh` boot them without one.

One piece is ours, a fork feature: the **card assist** (`hw/arm/pmb887x/card-assist.c`, `-object
pmb887x-card-assist,id=card`). The firmware of most of these phones never looks at the card again after a mount
(below), so a card changed under a running phone stays unseen; the assist makes the firmware's card server rescan and
can ask the phone to unmount the card first. It is opt-in: without the object the card works as upstream has it.
The probe that led to the first model is in [sd-card-probe.md](sd-card-probe.md).

## Use

```sh
# 64 MB FAT16 image with one partition at 1 MiB (the layout of a real card)
truncate -s 64M card.img
echo 'start=2048, type=6' | sfdisk card.img
mkfs.fat -F 16 -n CARD --offset 2048 card.img
mcopy  -i card.img@@1M hello.txt ::
mmd    -i card.img@@1M ::Pictures
mcopy  -i card.img@@1M test.png ::Pictures

CARD=card.img BOARD=siemens-el71 scripts/run-native.sh EL71v45.bin
mdir -/ -i card.img@@1M ::                # what the phone wrote
```

- `CARD=` adds `-drive if=sd,format=raw,file=<image>` and the card assist (`-object pmb887x-card-assist,id=card`).
  `CARD_DEBUG=1` makes the assist report what it does (`debug=on`). The image is writable, so stop qemu, or take the
  card out (below), before you run mtools on it.
- The card is SDSC only, because the firmware parses CSD v1 only. qemu's sd-card takes a power-of-two size, or a
  multiple of 256 KiB up to 1 GiB; the page pads any other image to the next power of two.
- Without `CARD`, CMD0 answers "sent" and CMD8, CMD55 and CMD1 time out. The firmware then decides there is no card.
- Debug: `-trace 'sdbus_*' -trace 'sdcard_*'` prints every command and block (`sdcard_read_block`/`sdcard_write_block`,
  byte addresses).

### Changing the card under a running phone

```sh
CARD=card.img MONITOR=unix:/tmp/mon.sock scripts/run-native.sh EL71v45.bin
(qemu) qom-set /objects/card inserted false      # the firmware sees the removal; its FS drops its cache
(qemu) eject sd0
mcopy -i card.img@@1M new.txt ::Misc/            # any host-side change
(qemu) change sd0 card.img raw
(qemu) qom-set /objects/card inserted true       # the firmware reads the card again
(qemu) qom-get /objects/card state               # 0 in, 1 out, 2 going out, 3 reading, 4 not seen
```

- The order matters: the card leaves the slot before its drive is closed, and the drive is open before the card
  goes back. The slot's own `qom-set /machine/peripheral/SD_SLOT inserted false` works as well, but then the
  firmware is not told.
- `qom-set /objects/card inserted true` right after `false` is fine: the insert is held until the firmware has
  seen the removal ("insert held" in the debug log), so the FS always sees a removal before the insertion.
- Properties of the object: `slot` (path of the sd-slot, when a board has more than one), `debug`, `inserted`, and
  read-only `state`, `writes` (write commands the card answered so far) and `unmount-state`.
- The browser page does the same through `wasm_card_eject`/`wasm_card_insert` (ui/wasm.c).

## wasm

- **Block I/O off the vCPU thread.** The upstream MCI calls the card from MMIO accesses and from its transfer timers,
  both on the vCPU thread, and qemu's block layer runs coroutines, which the wasm build can only switch on the main
  loop thread (`util/coroutine-wasm.c` aborts with "coroutine switch on the vCPU thread"). So `hw/sd/sd.c`
  (marked "PMB887X-WEB WASM PORT") runs a block read or write from that thread as a one-shot BH on the main loop while
  the vCPU waits with the BQL released (`sd_blk_io`); the card and its BlockBackend are held meanwhile, since the main
  loop may take the card out. The guest sees the same synchronous access. Native builds call directly.
- **`blk_is_inserted()` as well:** it always runs a coroutine, and sd.c asks it for every command and every data byte.
  The answer is kept by the main loop where the medium changes (`sd_cardchange`, `sd_realize`), and the vCPU thread
  reads that (`sd_get_inserted`). The test is the thread itself (`qemu_coroutine_current_thread_forbidden()`), not
  `current_cpu`: the MCI's timers run on the vCPU thread with no CPU current.
- **Asyncify.** The slot realizes the card when it binds its port, and `sd_realize`'s `blk_getlength` runs a
  coroutine, so that path (`qdev_bus_port_bind`, `bus_port_connect`, `sd_*`) is in `configs/meson/asyncify-only.txt`,
  with `wasm_card_bh`, `pmb887x_card_set_inserted` and the assist's held insert `cd_insert_bh`. Checked with
  `tools/cardcheck.mjs --costack` + `tools/asyncify-audit.mjs` (2026-11-27: S75, EL71, nothing missing).
- `tools/cardcheck.mjs --card <image>` boots a phone with the card in the page and runs out, in, a quick out+in, the
  clean unmount and a remount, each to the state the firmware must reach.
- `tools/cardfoldercheck.mjs` runs folder mode (the folder picker answered with an origin-private folder): a file added
  after boot must raise the "not on the card yet" notice when the window gets the focus, and Sync card must put it on
  the card and have the phone read the card again. Both are close-tier gate jobs (`card`, `cardfolder`).

## Verified (2026-11-27, upstream MCI + sd-slot + the card assist)

| check | result |
|---|---|
| native EL71 (`rr_ff_el71_stock.bin`), monitor `qom-set` out, mcopy, `change`, in | removal seen and card read again after 1 call each; CMD17 reads after the insert |
| native S75 (`S75v40lg1.bin`, a card-detect pin) | the same, 1 call each; no double rescan from the CD line |
| native EL71, QMP burst out+eject+change+in in one go | "insert held until the firmware has seen the removal", then both done |
| browser S75 (`s75_working…bin`) and EL71, `tools/cardcheck.mjs` | out, in, out+in, unmount (sent to the firmware), remount: PASS |
| browser S75, `tools/cardfoldercheck.mjs` | a file added after boot: notice on focus, Sync card puts it on the card, phone reads it in 3 s: PASS |

The 2026-11-23 checks of the phone with a card (My stuff lists the card, a picture opens, the phone copies a file onto
the card and `fsck.fat` is clean, Format card) were made with the fork's own MCI model, which upstream's replaced on
2026-11-27; its notes are in git history (this file before that date).

## Where the phones look (2026-11-27)

A phone shows only its own folders; files elsewhere on the card are there but invisible.
- **LG KE800** (KE800-v11b): on mount it creates `Images/`, `Videos/`, `Sounds/MP3/` (and lists `Others/`).
  My stuff ▸ External memory shows only Videos, Images, Sounds, Others, not the root or any other top-level
  folder. The **MP3 player** lists the MP3s in `Sounds/MP3/` only (long and 8.3 names both), and only those on the card
  when the phone booted: a Sync card while it runs puts them on the card (My stuff sees them) but the player's list
  stays as it was until a restart. Checked in the page with a folder card (`q08-mp3.png` run: two card MP3s after
  the 10 built-in tracks).
- **Siemens S75**: on mount it created `Pictures/` and `Videos/` on a card without them (cardfoldercheck run).

## Caching in the firmware's FAT driver (2026-11-23): can host changes show up live?

Short answer: no.
- After mount the firmware keeps the FAT and every directory it has read in RAM.
- It never re-reads them, and it never polls the card.
- A host-side change stays invisible until the phone reboots.
- If the phone writes after a host-side change, the image gets corrupted.

A live "folder synthesised as a block device" (vvfat-like) can therefore only be a snapshot taken at boot.
- Phone → host: writes reach the block device at once, so they can be decoded live, as vvfat does.
- Host → phone: changes need a reboot.

### Block log

These were taken with the fork MCI's block log (one line per transfer: `<virtual ms> R|W <card LBA> <blocks> CMDn`); with upstream's MCI, `-trace sdcard_read_block -trace sdcard_write_block` gives the same (byte addresses: LBA × 512).

On the test image (partition at LBA 2048):

| region | LBA |
|---|---|
| boot sector | 2048 |
| FAT1 | 2052-2179 |
| FAT2 | 2180-2307 |
| root directory | 2308-2339 |
| cluster n | 2340 + 4·(n−2) |

### What the firmware reads

| moment | blocks |
|---|---|
| mount (boot) | MBR; boot sector; **all of FAT1** (128 sectors, one by one); root directory, first sector only. FAT2 is never read. The `Videos` folder is created here (writes to dir, FAT1, FAT2) |
| My stuff > card tab | first sector of each subfolder (Misc c3, Pictures c5), for the "n entries" count, and the first sector of hello.txt (c2). The root directory is **not** read again |
| enter Pictures, back, enter again | Pictures' directory cluster c5 is **not** re-read. Each time only test.png's data (c6-c9, for the thumbnail, read 3 times) and, going back, c2. The same 25 reads both times |
| copy a file (Videos ← Pictures/test.png) | dir c10 write, source read, data written to the clusters that the **RAM copy of FAT** says are free (c11-c14), dir c10, then FAT1 sector 2052 and FAT2 sector 2180 written from RAM. **No FAT read before allocating** (FAT16 has no FSInfo, so the RAM copy is the free-cluster map) |

### Live test (phone running, image changed with mtools; qemu's `-drive` default cache, reads go to the file)

| host change | phone |
|---|---|
| file added to Misc (never opened on the phone), Pictures (visited) and root | not shown: Misc still lists "1 entry" and only NOTES.TXT; Pictures only TEST; no directory sector was read |
| file deleted (Misc/notes.txt) | still listed |
| then the phone copies a file | it took clusters 11-14, which the host had just used, and wrote FAT sector 2052 from its stale copy. `fsck.fat`: host files cross-linked with the phone's file (shared clusters), "contains a free cluster", truncated chains |

### Card removed

- **No polling.** No card command was sent in 60 s of idle with the card in. Commands go out only when the firmware reads or writes.
- **One retry, then absent until reboot.** An `eject -f sd0` from the monitor during an access made CMD13 time out. The firmware then tried CMD0/8/55/1 twice and gave up.
  - After that, the My stuff card tab no longer opens: right does nothing, as with no card at boot.
  - After `change sd0 <image> raw`, no command came in 40 s, and opening the tab sent none either.
- There is no card-detect interrupt on HW 0x28, so a remount would need either a firmware call to re-mount, or another phone/HW id with card detect. Neither was explored.

## Remount without a reboot (2026-11-23): the card assist

The firmware drops its FAT and directory cache when the card bus layer reports "removed", and reads them again when it reports "inserted". Both reports come from the card server's rescan. EL71 has no card-detect interrupt (HW id 0x28, below), and after a removal nothing in the firmware rescans again. The card assist starts the rescans itself, with no gdb and no per-firmware addresses (use: [above](#changing-the-card-under-a-running-phone)).

### How the assist starts a rescan (`cd_*` in card-assist.c)

The assist takes the card out of the slot or puts it in (`inserted`) and then makes the card server's own timer "expire", again and again, until the firmware has acted on the change:
- **The card server** is a set of Nucleus PLUS objects named `CARDSRV ` (task, event group, mailbox, semaphore, timer). Its one-shot timer is armed after every burst of block requests; its expiration routine (EL71v45 `FUN_a04ddd18`, E71v45 A04D7950) sets the rescan event when it expires (initial value 0x32C8 = 13 s in ms ticks; natively about 10 s after a mount; in the browser the guest runs slower than real time, so it can be a minute of wall time), if the server is idle then. That is the firmware's own idle rescan.
- **Found in RAM, not by address.** On each request the assist scans the RAM ranges of the system address space for Nucleus application timer blocks (`TM_APP_TCB`: id `TIME` at +12, name +16, expiration routine +24, its argument +28, enabled +32, the actual timer at +48 whose information field +56 points back at the block by its virtual address, so only the offset in the page is compared: part of RAM is also mapped elsewhere, e.g. the MTIMER blocks at physical A8015994 point to AD005994). The `CARDSRV ` block gives the routine to run.
- **Where it runs.** Nucleus runs expiration routines from the timer HISR. The model puts a one-shot translator hook (`arm_pc_hook_addr`, target/arm, A32 and Thumb) on the routine most enabled timers use (on both phones the Siemens MTIMER routine A00978BB, Thumb, firing every 0.2-1 s). At its entry the registers are saved and the guest is sent to the CARDSRV routine (r0 = its argument, LR = the hook address); when it returns there with the same SP the registers come back and the original routine runs. This is what Nucleus would do if the CARDSRV timer expired at that tick.
- **Until it is done.** Each change sets a goal: a removal is done when the firmware's rescan has failed on the card and switched it off (the card stays hidden, commands time out, until then); an insertion is done when the firmware reads a block again (CMD17/18: the FS mounts). While a goal is open the hook stays armed, and at each tick of the hooked routine the CARDSRV routine is run if its own timer is not running and the last run is 1.5 s (host time; virtual time cannot be read in the middle of a TB under icount) ago, at most 10 runs and 10 minutes per goal (then the assist gives up: log "giving up", page state "not seen"; a removal stops hiding the card).
  - Not while the CARDSRV timer is running: Nucleus runs the routine only on an expired timer, and on a running one its `NU_Reset_Timer` fails (firmware exit 0x000F "cardsrv", seen in the browser test). After card I/O (a mount, an explorer listing, a rescan of its own) it runs for ~13 s of guest time; waiting it out made a second change take ~10 s natively and up to a minute in the browser.
  - **So the running timer is moved up** (`cd_expedite`), in the hook, i.e. in the timer HISR inside Nucleus's expiration loop, the context in which Nucleus itself changes the list. Nucleus PLUS's active timer list: `TM_TCB` (+48 of the `TM_APP_TCB`): +0 type (`TM_TASK_TIMER` 0, `TM_APPL_TIMER` 1), +4 remaining time, +8 information, +12 next, +16 previous; circular, doubly linked, sorted; the head's remaining time absolute, the others deltas to the one before. The head pointer (`TMD_Active_Timers_List`) is found once, by value: the only RAM word that points at a member of the list (walked from the CARDSRV entry) and is not a member's own link field; it is checked again before every use. The CARDSRV entry is unlinked (its delta added to the next entry's) and linked in right after the head with delta 0, so it expires together with the next timer of all (within ~0.2-1 s), and Nucleus runs its routine normally (timer disabled first, no exit). If its routine then does not rescan (server busy), the goal loop goes on as above. Any mismatch (list not consistent, not exactly one head candidate): nothing is written, the assist waits for the timer as before, and the page shows "waiting for the phone's card timer".
  - Siemens' Nucleus clears the next/previous fields of a timer when it expires (seen in RAM: the expired MTIMER entry has type 1, next 0, prev 0), so the head cannot be reached through the timer that just fired; hence the head pointer search.
  - Measured (native, `-icount`): eject + empty file + insert 10 s after boot, then 2 s later a second change while the timer runs from the first mount. Before: 0.3-0.8 s and ~10 s (the timer waited out, 520-540 hook hits). After: 0.5 s and 0.8 s on EL71v45 (timer moved up 2 times, the removal then seen by Nucleus's own expiry, 0 runs from the assist); 0.5 s and 0.5 s on E71v45, same binary. The phone lists EMPTY.TXT (0 bytes) and HOSTADD.TXT afterwards.
  - In the hook there is no `DEBUG_LOG`: its time stamp reads the virtual clock, which icount forbids in the middle of a TB ("Bad icount read"); the counts are logged when the goal is done or at the next media change.
  - The first version (2026-11-23 morning) made one call per change and, when the timer was running, skipped it trusting the timer's own expiry. That expiry rescans only if the server is idle at that moment, so a removal could stay unseen, the insertion waiting behind it forever: the phone lost the card after a folder change in the browser (user report, an empty file added).
- **Removal first.** An insertion that comes while the removal is not seen yet waits for it, so a quick eject + insert still shows the FS a "removed" before the "inserted".
- **State** for the page: `wasm_card_state()` and the object's `state` (= `pmb887x_card_state`): 0 in (read again), 1 out, 2 going out, 3 reading, 4 not seen (gave up); `| 0x10` while it waits for a CARDSRV timer it could not move up.
- **Inert** when there is no `CARDSRV ` timer (another OS or layout): the card changes, the firmware is not told (log "no CARDSRV timer"). For experiments without it leave the object out and use the slot's `inserted`.
- The earlier version (a per-firmware table calling the card-detect callback at `NU_Retrieve_Events`) is gone. The translator hook stays: a plain cpu breakpoint does not fire in the wasm build (its inlined TB chaining and pc caches skip `check_for_breakpoints`).

### Verified

- EL71v45 native, the goal version: phone idle, eject + `mcopy` an empty EMPTY.TXT + insert at once, 4 s later eject + HOSTADD.TXT + insert: each removal and insertion done after one call; the card tab then lists EMPTY.TXT (0 bytes), HOSTADD.TXT and NOTES.TXT in Misc.
- E71v45 native, the goal version, same binary and sequence: both removals and insertions done (the second insertion by the firmware's own rescan, 0 runs); after each the FS reads LBA 0, 2048, 2052, 2308.
- Browser (wasm), the goal version: with the phone idle a folder change took about a minute (the removal waited 456 hook hits with the CARDSRV timer running, then 1 run; the phone then read the card by itself); with the explorer open on Misc an empty file and 6 s later a second file: two pushes one after the other, the second seen by the firmware without a run (its explorer's failed select rescans). State "going out > reading > in" each time, no firmware exit.
- Browser, with the timer move-up and Sync card (dist-jit 2026-11-23): from the click to the phone having read the card again 1.8 s with the phone idle (explorer closed, screen dark), 2.5 s with the explorer open on Misc, 1.0 s for a second push right after; the removals were done by Nucleus expiring the moved-up timer or by one run. The phone then shows its own note "Data lost! Use option 'Eject card'." after every push, also when idle with the explorer closed: the firmware's reaction to a card removed without its "Eject card" option (the FS had it mounted), not an error of the emulator; OK closes it, the files are there. Gone since the clean unmount below.
- The first version lost such a change in the user's Edge (an empty file added while the phone ran); in the headless test it happened not to (timing).
- EL71v45 native, first version: eject, `mcopy` HOSTADD.TXT into Misc, insert: the removal is seen, the insert re-identifies the card and the FS mounts (about 150 reads with the card tab open); My stuff > card > Misc lists HOSTADD.TXT and NOTES.TXT ("2 entries"). Hook on A00978BB (Thumb), 82 timers found, 13 enabled.
- E71v45 native (`siemens-e71`, `E71_45_lg91_From_00.bin`), same binary: CARDSRV routine A04D7950 found, removal seen, after the insert the FS reads MBR, boot sector, FAT and root (LBA 0, 2048, 2052, 2308). Its UI with SIM=none stays at "Please insert your SIM card!", so the explorer was not looked at.
- Without the assist (no call): the removal is still noticed (an eject during an idle rescan: CMD0/8/55/1 time out three times), the insert never is: no MCI command at all after `change`, even with the card tab opened.
- The earlier gdb-based checks (same FS path): host changes between eject and insert all show after the insert (files added in Misc, Pictures and the root, a file deleted); the phone then copied a file into the cluster freed by the host delete, `fsck.fat` clean. A rescan with the card left in only re-identifies it: presence does not change, so the FS gets no event. The card has to go out and come back in.

### Clean unmount before the change (2026-11-24): no "Data lost"

"Sync card" first asks the phone to unmount the card itself, as its "Eject card" option does:
message 0x18 to the memory card file system process 0x4100 with drive 4,
`GBS_SendMessage(0x4100, 0x18, 0, 4, 0)` (`pmb887x_card_unmount`, `wasm_card_unmount`).
- The FS writes its FAT and directories to the card and drops its cache. The card then goes out and in as above; the FS
  mounts it on the next access. The note "Data lost" is only for a card removed while mounted, so it does not come.
- `GBS_SendMessage` is found in the flash (from A0000000) by the ElfPack function library patterns of SWI 0x100
  (`sdk/swilib/patterns.toml`: ELKA Thumb, NSG ARM), once, at the first sync; it has to match exactly once.
  The call is made from the same hook as the CARDSRV routine (the timer HISR, where the firmware's GBS timers post
  their messages too): registers saved, r0-r3 + one stack word set, LR = the hook, back there with the same SP.
- The page then waits until the phone has stopped writing to the card (600 ms) before it takes the image.
- Not found (0 or 2+ matches), no CARDSRV timer or hook: state 3, the old way (out/in only, with the note).
- The FS refuses the unmount while a file on the card is open; the assist does not see that (the reply goes to no
  process), so the change then goes on as before, with the note.
- Verified in the browser (dist-jit, EL71v45 `el71-23oct-full.bin`, tools/cardcheck.mjs): every push "clean unmount:
  true", no note, the phone reads the card again in 1.9-3.6 s, all checks pass. With the card tab open the explorer
  goes back to the phone memory tab on each push (as with "Eject card"). E71 and NSG phones: the pattern matches
  (E71v45 A0091EAA, S75v52 A0092A94, S68v52 A0092A04), the sync itself not run there.

### Path (EL71v45)

1. **Trigger.** Something sets the CARDSRV rescan event (`A8D9681C`, `NU_Set_Events(.., 1)`):
   - the card-detect callback `FUN_a04df5d8(1, 0)`, which the bus layer registers through host op `FUN_a04e11cc` at `*A8D968D8` (handle 1 at `+4`, stored on HW id 0x28 too) and the CD HISR of HW ids 0x20/0x2C calls;
   - the CARDSRV timer routine `FUN_a04ddd18` (what the emulator uses, above);
   - the block I/O task when selecting the card fails.
2. **Rescan task** `FUN_a04df640` runs `FUN_a04df33c` (identify, CSD into `A8D95E1C`/`A8D968CC`). It compares the card's presence with each client's flag at `+5`. The clients' table is at `A8D95D94`; the client in use is `A8D95DA4`. On a change it calls the client with event 0 (inserted, CSD info) or 1 (removed).
3. **Storage client** `FUN_a04dcc44`:
   - inserted → `FUN_a04dcbbc`;
   - removed → `FUN_a04dcc10`.
   Both call the upper layer's handler at slot `A8D95C98+4`, which is `FUN_a04d987c`.
4. `FUN_a04d987c` posts a **GBS message to 0x4100** with {slot, event, info}. The FS task mounts or unmounts on it.
   - On mount it reads the MBR, boot sector, FAT sector 0 and the root directory.
   - The rest of FAT1 is read lazily, on the first access (128 sectors when the card tab opened).

The bus layer starts a rescan in two other places:
- the block I/O task (`FUN_a04df0dc`), when selecting the card fails;
- `FUN_a04ddd18` (timer).
That is how a failed access after an eject leads to "removed". After a reinsert, nothing on EL71 calls the rescan again.

### Hardware card detect: not reachable on EL71

The driver init (`FUN_a04e16c8`) and the power and callback code (`FUN_a04e1ffc`/`FUN_a04e20b0`/`FUN_a04e1b08`) wire up the card-detect pin only when `FUN_a04e28b0()` is true, that is HW id 0x20 or 0x2C. The wiring is: logical pin 0x124 → external-interrupt line 9, set up by `FUN_a0548310/a0548138/a0548330/a0548414` and unmasked by `FUN_a0548480`.
- On 0x28 the line is never registered or unmasked.
- So raising IRQ 0x4B in the emulator would not reach the MMCI ISR, which on 0x4B goes to the HISR and then to `FUN_a04e1190` → `*A8D968D8`.
- The callback itself is registered on 0x28.
- **Where the HW id comes from.** `FUN_a05612ec` sets it to `0x20 + code & 0xF`; `FUN_a05610e8` takes the code from a 16-byte block at 0x80020/0x81020 (magic 0x1234/0x5678, blank on EL71) or else from six GPIO pins (port manager ids 0x82, 0x81, 0x80, 0x83, 0x84, 0x86 = bits 0..5). In the emulator those are the board straps `HW_DET_MOB_TYPE1..4` in `bsp/lib/data/board/*.toml`: EL71 1000b = 0x28, E71 1011b = 0x2D; among the NSG boards 0x20 is S75 and 0x2C C81.
- **Another strap is no way out.** `FUN_a05613e8` (from `FUN_a04e6ca4`, at boot) stops with "Invalid HW" unless the id is exactly 0x28, and 27 functions in several modules read the id.

### Format card

To get there: My stuff > card tab > Options > Format card. It asks two confirmations and then a phone code; with no code set, it asks for a new one twice.
- **What it reads first:** MBR, boot sector, FAT sector 0 and root. This is the mount read.
- **What it writes:** a fresh layout in LBA 0-160 (a new MBR whose partition starts at **LBA 32**, FAT16 with 32 sectors per cluster, 1 reserved sector). It then creates `Videos` and `Pictures`.
- **What it reads after:** the new FAT and root (LBA 65, 97, …), so its cache is rebuilt from disk.
- `fsck.fat` on the new partition is clean.
- The old file system at 1 MiB is left in the image but is unreferenced.

## Browser: a folder as the card

**Memory card**, above Advanced in the Firmware panel (shown only for boards with an sd-slot; the others boot without one).
The line under the pickers says what is chosen ("SD Card: synced to folder *name*" / "SD Card: image *name* (N MB)", with Remove):
- **Folder…** (Chrome/Edge, File System Access API, read+write): the page builds a FAT16 SD image from the folder (`site/sdcard.js`: MBR with one FAT16 partition at LBA 2048, 2 FATs, 512 root entries, VFAT long names, power-of-two size 64 MB-2 GB, at least 4 sectors per cluster) and keeps the two in sync while the phone runs. Entries starting with `.` are left out.
- **Image…**: a raw card image is the card (padded to a power of two when qemu would refuse its size); no sync. What the phone writes stays in the page: the next run starts from it, and **Card** downloads it. The file picked is never written.
- **Card** (Export row): downloads the image as it is now. **Sync card**: put the folder on the card at once (below).

The image is a MEMFS file (`/data/card.img`) given to qemu as `-drive if=sd,format=raw`, with the card assist. Sync (`site/app.js`, "memory card"):
- **phone → folder.** `wasm_card_writes()` counts the blocks the phone wrote. When it changed and then stayed still for 3 s, the page reads the image (FAT parse in JS) and writes new and changed files to the folder and deletes the ones the phone deleted. A file deleted on the phone is deleted on disk only if the disk copy is unchanged since the last sync.
- **folder → phone.** Only on **Sync card** (user 2026-11-23, again 2026-11-27: no automatic folder poll; a half-written folder is never pushed, and every push is a card swap that closes whatever the phone has open from the card). The page checks the folder (sizes and dates) when its window gets the focus and after each pull, and the state line then says "the folder has changes not on the card yet: Sync card". Sync card: the phone unmounts the card first (`wasm_card_unmount()`, as its own "Eject card", so no "Data lost" note), then `wasm_card_eject()`, the phone's changes are pulled, the image is rebuilt from the folder, written to MEMFS and `wasm_card_insert()` (path in `wasm_card_buf()`; `wasm_card_done()` counts finished eject/insert operations). The phone sees a removal and an insertion and reads the card again (above). The page then waits (at most 4 minutes; with the timer move-up about a second) until `wasm_card_state()` says the phone has read the card; the button stays disabled meanwhile, so pushes never overlap and never eject in the middle of a mount.
- **Card state** under Export: "Card: in / out / going out… N s / reading… N s / not seen by the phone", with "(waiting for the phone's card timer, ~13 s of phone time)" when the assist could not move that timer up.
- **Both changed** the same file: the folder keeps its version and the phone's is written next to it as `name~phone.ext`.
- What the phone writes as plain 8.3 names comes back in capitals (`TEST.PNG`).


The page shows a worker's own error text now (message, place) instead of "Uncaught [object ErrorEvent]"; the wasm stack is not in that event (emscripten rethrows it without it), the tool scripts get it by listening for `error` inside the workers.
