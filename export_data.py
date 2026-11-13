"""
export_data.py
==============
Run this script in an environment where xarray, zarr, gcsfs,
numpy, and pandas are installed.

It exports annual-mean surface air temperature data for four SSP scenarios
from the CESM2 CMIP6 model into a high-performance binary structure that the D3.js
visualization loads quickly.

Usage:
    python export_data.py

Output:
    data/cmip6_tas_annual.bin  — binary temperature grid (~36 MB)
    data/cmip6_meta.json       — dataset metadata (~5 KB)
"""

import json
import os
import numpy as np
import pandas as pd
import xarray as xr
import gcsfs

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MEMBER = "r11i1p1f1"
SCENARIOS = {
    "ssp126": "SSP1-2.6 (Low emissions)",
    "ssp245": "SSP2-4.5 (Intermediate)",
    "ssp370": "SSP3-7.0 (High intermediate)",
    "ssp585": "SSP5-8.5 (High emissions)",
}
YEAR_START = 2015
YEAR_END   = 2100

os.makedirs("data", exist_ok=True)

# ---------------------------------------------------------------------------
# Load catalog
# ---------------------------------------------------------------------------
print("Loading CMIP6 catalog …")
df = pd.read_csv("https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv")
gcs = gcsfs.GCSFileSystem(token="anon")

# ---------------------------------------------------------------------------
# Load each scenario
# ---------------------------------------------------------------------------
def load_scenario(experiment_id, member):
    print(f"  Loading {experiment_id} / {member} …")
    rows = df.query(
        "activity_id=='ScenarioMIP' & table_id=='Amon' "
        f"& variable_id=='tas' & experiment_id=='{experiment_id}' "
        "& source_id=='CESM2'"
    )
    if len(rows) == 0:
        raise ValueError(f"No rows found for {experiment_id}")
    # Try the requested member; fall back to first available
    sub = rows.query("member_id == @member")
    if len(sub) == 0:
        sub = rows
        print(f"    member {member} not found; using {sub.iloc[0].member_id}")
    row = sub.iloc[0]
    # decode_times=False avoids the cftime dependency; we decode years manually below
    ds = xr.open_zarr(gcs.get_mapper(row.zstore), consolidated=True,
                      decode_times=False)
    return ds

# ---------------------------------------------------------------------------
# Process and export
# ---------------------------------------------------------------------------
# We want annual means for each (year, lat, lon).
# To make file size smaller we could coarsen the grid,
# reducing the resolution by the COARSEN factor.
COARSEN = 1   # factor along each axis

all_scenarios = {}

for exp_id, label in SCENARIOS.items():
    ds = load_scenario(exp_id, MEMBER)

    # ----------------------------------------------------------------
    # Decode years manually from the raw time coordinate.
    # The 'units' attribute looks like "hours since 2015-01-15 …".
    # We parse the reference year and add the offset divided by the
    # number of hours per time step, then derive the calendar year.
    # A simpler approach: reconstruct a year array from the units string.
    # ----------------------------------------------------------------
    time_var  = ds["time"]
    units_str = time_var.attrs.get("units", "")  # e.g. "hours since 2015-01-15 12:00:00"
    # Extract the reference date from the units string
    # e.g. "hours since 2015-01-15 12:00:00.000000"
    import re as _re
    m = _re.search(r'since\s+(\d{4})-(\d{2})-(\d{2})', units_str)
    if m:
        ref_year  = int(m.group(1))
        ref_month = int(m.group(2))
        ref_day   = int(m.group(3))
    else:
        raise ValueError(f"Cannot parse units string: {units_str!r}")

    # Determine the time unit (hours / days)
    time_unit_str = units_str.split()[0].lower()

    raw_times = time_var.values.astype(float)  # e.g. hours since ref date

    # Convert raw offset → approximate fractional year using the noleap calendar
    # (365 days/year, no leap days)
    DAYS_PER_YEAR_NOLEAP = 365.0
    if time_unit_str == "hours":
        days_since_ref = raw_times / 24.0
    elif time_unit_str == "days":
        days_since_ref = raw_times
    else:
        # generic: assume minutes
        days_since_ref = raw_times / 1440.0

    # Reference day-of-year (1-indexed, noleap)
    _MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31]
    ref_doy = sum(_MONTH_DAYS[:ref_month-1]) + ref_day  # day of year of ref date

    # Total days from year 1 to reference date in noleap calendar
    ref_abs_days = (ref_year - 1) * DAYS_PER_YEAR_NOLEAP + ref_doy

    abs_days = ref_abs_days + days_since_ref  # absolute day number for each time step
    year_floats = abs_days / DAYS_PER_YEAR_NOLEAP + 1   # approximate year (1-based)
    year_ints   = year_floats.astype(int)                # integer year for each time step

    # Build a new integer 'year' coordinate and group by it
    tas = ds.tas.assign_coords(year=("time", year_ints))
    annual = tas.groupby("year").mean("time")

    # Restrict to 2015–2100
    annual = annual.sel(year=slice(YEAR_START, YEAR_END))

    # Convert Kelvin → Celsius
    annual = annual - 273.15

    # Coarsen grid for smaller file
    print(f"  Coarsening {exp_id} …")
    annual_coarse = annual.coarsen(lat=COARSEN, lon=COARSEN, boundary="trim").mean()

    # Trigger computation
    print(f"  Computing {exp_id} …")
    annual_coarse = annual_coarse.load()

    all_scenarios[exp_id] = annual_coarse

# Use the lat/lon/year from the last loaded scenario (all same grid)
lats  = annual_coarse.lat.values.tolist()
lons  = annual_coarse.lon.values.tolist()
years = annual_coarse.year.values.tolist()

print("Exporting high-performance binary dataset …")

meta_clean = {
    "meta": {
        "scenarios": SCENARIOS,
        "years": [int(y) for y in years],
        "lats": [round(float(v), 4) for v in lats],
        "lons": [round(float(v), 4) for v in lons],
        "units": "°C",
        "model": "CESM2",
        "member": MEMBER,
        "note": "Annual mean surface air temperature",
    },
    "scenarios": list(SCENARIOS.keys()),
    "years": [int(y) for y in years],
    "nLats": len(lats),
    "nLons": len(lons),
    "scale": 100,
    "dtype": "int16"
}

with open("data/cmip6_meta.json", "w") as f:
    json.dump(meta_clean, f, indent=2)

bin_path = "data/cmip6_tas_annual.bin"
print(f"Writing {bin_path} …")
stacked = np.stack([all_scenarios[exp].values for exp in SCENARIOS.keys()])
int16_data = np.round(stacked * 100).astype(np.int16)
int16_data.tofile(bin_path)

bin_size_mb = os.path.getsize(bin_path) / 1e6
print(f"Done! {bin_path} is {bin_size_mb:.1f} MB (data/cmip6_meta.json is {os.path.getsize('data/cmip6_meta.json')} bytes)")
print()
print("Next: open index.html in a browser (served from a local HTTP server).")
print("  e.g.:  python -m http.server 8080")
