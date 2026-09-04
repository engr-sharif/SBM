/* SBMM Site Explorer — the water kernels, checked in node against the golden
   numbers of docs/V10_WATER_SPEC.md §9/§10.

   This is now a thin alias. Every kernel in js/compute.js has a section in
   test/kernels.mjs (V11 spec §2), and the water checks are the "water" section
   of it — the same 59 checks, the same numbers, the same references from
   test/fixtures/, with the two windows cut from the real terrain PNGs instead
   of the planner's scratchpad .f32 fixtures. The file stays because it is what
   anyone touching flowpath / overtop / catchment reaches for, and because it is
   named in CLAUDE.md.

     node test/water_kernels.mjs            the water section only
     node test/kernels.mjs                  every section
     node test/kernels.mjs --only water     identical to this file

   Any argument the old harness took (a scratch directory, --swale, --herman,
   --dropref, --hermanref, --gis) is ignored: the references are in the repo
   now and the windows are derived, so there is nothing left to point at. */
if (process.argv.length > 2)
  console.log("note: test/water_kernels.mjs no longer takes arguments — the references are in\n" +
              "      test/fixtures/ and the windows are cut from data/*.png. Ignoring: " +
              process.argv.slice(2).join(" ") + "\n");
process.argv.splice(2, process.argv.length - 2, "--only", "water");
await import("./kernels.mjs");
