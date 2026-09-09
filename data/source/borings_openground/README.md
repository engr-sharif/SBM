# OpenGround boring-log export (raw, as delivered)

Drop the OpenGround export of the 2025 borings in this folder, as delivered:

- the **AGS4** file (`.ags`) if OpenGround offers it — one self-describing text
  file with every table; or
- the **per-table CSV / Excel** export — at least `LOCA` (hole locations and
  collar elevations), `GEOL` (strata by depth), `SAMP` and `ISPT` (samples and
  blow counts), and `MOND` / `WSTG` if water levels were logged; and
- a few of the **PDF boring logs**, to check the parsed intervals against the
  driller's print.

Nothing in this folder is read by the app. `tools/build_borings.py` (to be
written when the export lands) turns it into the baked dataset the app carries
(`data/datasets/ds_borings2025.json`, joined by hole ID to the 44 borings
already placed from the December 2025 coordinate spreadsheet), and the
integration is recorded in README.md and docs/HANDOFF.md.

Coordinates are expected in NAD83(2011) California State Plane Zone 2, US
survey feet (EPSG:6418); the builder checks that and says what it found.
