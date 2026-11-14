/**
 * main.js  —  CMIP6 Temperature Scenario Explorer
 *
 * Loads pre-exported CMIP6 data (data/cmip6_tas_annual.bin, data/cmip6_meta.json)
 * then renders:
 *   • A 2D raster heatmap showing ΔT = scenario A − scenario B
 *   • A colour bar legend with dynamic scale
 *   • A latitude-band bar chart
 *   • A global-mean time-series line chart
 *
 * Only D3.js (v7) is used for the visualisation.
 */

// ── Constants ───────────────────────────────────────────────────────────
const META_URL = "data/cmip6_meta.json";
const BIN_URL  = "data/cmip6_tas_annual.bin";

const SCENARIO_COLORS = {
  ssp126: "#22d3ee",
  ssp245: "#cbda23",
  ssp370: "#fb923c",
  ssp585: "#f43f5e",
};

// lat bands for the bar chart
const BANDS = [
  { label: "90°S–60°S", lo: -90, hi: -60 },
  { label: "60°S–30°S", lo: -60, hi: -30 },
  { label: "30°S–0°",   lo: -30, hi:   0 },
  { label: "0°–30°N",   lo:   0, hi:  30 },
  { label: "30°N–60°N", lo:  30, hi:  60 },
  { label: "60°N–90°N", lo:  60, hi:  90 },
];

// ── State ───────────────────────────────────────────────────────────────
let appData   = null;   // the full dataset payload
let worldTopo = null;   // world boundaries TopoJSON
let scenarioA = null;
let scenarioB = null;
let currentYear = 2015;
let playTimer  = null;
let currentDiff = null;   // latest {diff, lats, lons} for tooltip lookups
let lastMousePos = null;  // last cursor position { clientX, clientY } for live tooltip updates
let isZoomingOrPanning = false; // true while panning or zooming to hide tooltip

// ── D3 selections / scales (created once, updated on change) ────────────
let mapSvg, mapG, mapWidth, mapHeight;
let colorScale;
let bandSvg;
let tsSvg;
let yearLineG;   // group for the vertical year marker on the ts chart
let tsScales;    // { x, y } for the ts chart
let mapZoom;     // d3.zoom instance for the map

// ── Data Loading & Streaming Progress ──────────────────────────────────
async function loadDataset() {
  // 1. Fetch metadata and world country boundaries in parallel (instant)
  updateProgress(0, 38043648, "Loading metadata…");
  const [metaRes, worldRes] = await Promise.all([
    fetch(META_URL),
    fetch("data/countries-110m.json").catch(() => null)
  ]);
  if (!metaRes.ok) throw new Error(`Could not load ${META_URL}`);
  const metaJson = await metaRes.json();
  if (worldRes && worldRes.ok) {
    try {
      worldTopo = await worldRes.json();
    } catch {}
  }

  // Exact binary size from dimensions: 4 scenarios * 86 years * 192 lats * 288 lons * 2 bytes
  const total = metaJson.scenarios.length * metaJson.years.length * metaJson.nLats * metaJson.nLons * 2;

  // 2. Stream binary dataset with smooth animated progress
  const binRes = await fetch(BIN_URL);
  if (!binRes.ok) throw new Error(`Could not load ${BIN_URL}`);

  const reader = binRes.body.getReader();
  const allBytes = new Uint8Array(total);
  let loaded = 0;
  let lastYield = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    allBytes.set(value, loaded);
    loaded += value.length;

    const now = performance.now();
    if (now - lastYield > 25) {
      lastYield = now;
      updateProgress(loaded, total, "Downloading climate dataset…");
      // Yield to browser event loop so DOM updates paint on screen
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Ensure 100% full bar is displayed and hold briefly so the user sees it reach the end
  updateProgress(total, total, "Initializing climate visualizer…");
  await new Promise(r => setTimeout(r, 250));

  const binaryData = new Int16Array(allBytes.buffer, allBytes.byteOffset, allBytes.byteLength / 2);

  return {
    isBinary: true,
    meta: metaJson.meta,
    scenariosList: metaJson.scenarios,
    binaryData: binaryData,
    scale: metaJson.scale || 100
  };
}

// ── Bootstrap ───────────────────────────────────────────────────────────
async function init() {
  try {
    appData = await loadDataset();
  } catch (e) {
    showOverlay(
      "⚠️  Climate data not found or failed to load.\n\n" +
      `Details: ${e.message}`,
      true
    );
    return;
  }

  buildUI();
  buildMap();
  buildBandChart();
  buildTimeSeries();
  update();

  hideOverlay();
}

// ── UI: populate scenario selectors ────────────────────────────────────
function buildUI() {
  const { scenarios } = appData.meta;
  const ids = Object.keys(scenarios);

  // Default selection: first two scenarios
  scenarioA = ids[ids.length - 1];   // e.g. ssp585 (most dramatic)
  scenarioB = ids[0];                // e.g. ssp126

  for (const sel of ["scenarioA", "scenarioB"]) {
    const el = document.getElementById(sel);
    ids.forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${scenarios[id]}`;
      el.appendChild(opt);
    });
  }

  document.getElementById("scenarioA").value = scenarioA;
  document.getElementById("scenarioB").value = scenarioB;
  updateTagLabels();

  document.getElementById("scenarioA").addEventListener("change", e => {
    scenarioA = e.target.value;
    updateTagLabels();
    update();
  });

  document.getElementById("scenarioB").addEventListener("change", e => {
    scenarioB = e.target.value;
    updateTagLabels();
    update();
  });

  // Year slider
  const slider = document.getElementById("year-slider");
  const { years } = appData.meta;
  slider.min  = years[0];
  slider.max  = years[years.length - 1];
  slider.value = currentYear = Math.min(2015, years[years.length - 1]);
  document.getElementById("year-display").textContent = currentYear;

  slider.addEventListener("input", () => {
    currentYear = +slider.value;
    document.getElementById("year-display").textContent = currentYear;
    update();
  });

  // Play button
  const playBtn = document.getElementById("btn-play");
  playBtn.addEventListener("click", togglePlay);

  // Speed toggle (1× / 2×), created dynamically so only main.js changes
  const speedBtn = document.createElement("button");
  speedBtn.id = "btn-speed";
  speedBtn.type = "button";
  speedBtn.title = "Playback speed";
  speedBtn.textContent = "1×";
  speedBtn.style.marginLeft = "6px";
  speedBtn.style.minWidth = "44px";
  speedBtn.addEventListener("click", () => {
    playSpeed = playSpeed === 1 ? 2 : 1;
    speedBtn.textContent = playSpeed + "×";
    // subtle highlight when boosted
    speedBtn.style.background = playSpeed === 2 ? "#1d4ed8" : "";
    // if currently playing, restart the timer so the new speed takes effect now
    if (playTimer) { clearInterval(playTimer); startPlayTimer(); }
  });
  playBtn.parentElement.appendChild(speedBtn);
}

function updateTagLabels() {
  const elA = document.getElementById("tagA-label");
  const elB = document.getElementById("tagB-label");

  if (elA) {
    elA.textContent = scenarioA.toUpperCase();
    const colorA = d3.color(SCENARIO_COLORS[scenarioA] || "#ea6600");
    elA.style.backgroundColor = colorA ? colorA.darker(0.8).formatHex() : (SCENARIO_COLORS[scenarioA] || "#ea6600");
  }

  if (elB) {
    elB.textContent = scenarioB.toUpperCase();
    const colorB = d3.color(SCENARIO_COLORS[scenarioB] || "#0284c7");
    elB.style.backgroundColor = colorB ? colorB.darker(0.8).formatHex() : (SCENARIO_COLORS[scenarioB] || "#0284c7");
  }
}

// ── Map / Image Plot ───────────────────────────────────────────────────
const SVG_W = 880;
const SVG_H = 460;
const PLOT_MARGIN = { top: 40, right: 90, bottom: 30, left: 30 };
const PLOT_W = SVG_W - PLOT_MARGIN.left - PLOT_MARGIN.right;
const PLOT_H = SVG_H - PLOT_MARGIN.top - PLOT_MARGIN.bottom;

function updateLastMousePosFromEvent(e) {
  if (!e) return;
  const ev = e.sourceEvent || e;
  if (typeof ev.clientX === "number" && typeof ev.clientY === "number") {
    lastMousePos = { clientX: ev.clientX, clientY: ev.clientY };
  } else if (ev.touches && ev.touches.length > 0) {
    lastMousePos = { clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY };
  } else if (ev.changedTouches && ev.changedTouches.length > 0) {
    lastMousePos = { clientX: ev.changedTouches[0].clientX, clientY: ev.changedTouches[0].clientY };
  }
}

function buildMap() {
  mapSvg = d3.select("#map-svg")
    .attr("viewBox", `0 0 ${SVG_W} ${SVG_H}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("cursor", "grab");

  mapSvg.selectAll("*").remove();

  // ── Defs: gradient + clip path ────────────────────────────────────────
  const defs = mapSvg.append("defs");

  // Clip path so zoomed content never bleeds outside the plot area
  defs.append("clipPath")
    .attr("id", "plot-clip")
    .append("rect")
    .attr("x", PLOT_MARGIN.left)
    .attr("y", PLOT_MARGIN.top)
    .attr("width", PLOT_W)
    .attr("height", PLOT_H);

  // ── Static white background (outside zoom group) ──────────────────────
  mapSvg.append("rect")
    .attr("x", PLOT_MARGIN.left)
    .attr("y", PLOT_MARGIN.top)
    .attr("width", PLOT_W)
    .attr("height", PLOT_H)
    .attr("fill", "#fff")
    .attr("stroke", "none");

  // ── Clip wrapper (static, never transformed) ─────────────────────────
  // The clip-path MUST be on an element that has no d3.zoom transform applied
  // to it. If clip-path is on the zoom group itself, SVG resolves clipPath
  // coordinates in the element's own (transformed) coordinate system, so the
  // clip rect moves with the zoom — the wrong behaviour. By putting it on a
  // static parent wrapper the clip rect stays fixed in SVG root coordinates.
  const clipWrapper = mapSvg.append("g")
    .attr("clip-path", "url(#plot-clip)");

  // ── Zoom group (inside the static clip wrapper) ───────────────────────
  // This group receives the CSS transform from d3.zoom
  const zoomG = clipWrapper.append("g")
    .attr("id", "map-zoom-group");

  // Raster image element for the 2D temperature grid
  zoomG.append("image")
    .attr("id", "plot-image")
    .attr("x", PLOT_MARGIN.left)
    .attr("y", PLOT_MARGIN.top)
    .attr("width", PLOT_W)
    .attr("height", PLOT_H)
    .attr("preserveAspectRatio", "none");

  // Country borders and coastlines overlaid with exact equirectangular projection
  if (worldTopo && typeof topojson !== "undefined") {
    const proj = d3.geoEquirectangular()
      .fitExtent([
        [PLOT_MARGIN.left, PLOT_MARGIN.top],
        [PLOT_MARGIN.left + PLOT_W, PLOT_MARGIN.top + PLOT_H]
      ], { type: "Sphere" });
    const pathGen = d3.geoPath(proj);

    // Coastlines / land outlines
    if (worldTopo.objects.land) {
      zoomG.append("path")
        .datum(topojson.feature(worldTopo, worldTopo.objects.land))
        .attr("class", "coastlines")
        .attr("d", pathGen);
    }

    // Country interior borders
    if (worldTopo.objects.countries) {
      zoomG.append("path")
        .datum(topojson.mesh(worldTopo, worldTopo.objects.countries, (a, b) => a !== b))
        .attr("class", "country-borders")
        .attr("d", pathGen);
    }
  }

  // ── Static overlay border (drawn on top of zoom group, stays fixed) ───
  mapSvg.append("rect")
    .attr("x", PLOT_MARGIN.left)
    .attr("y", PLOT_MARGIN.top)
    .attr("width", PLOT_W)
    .attr("height", PLOT_H)
    .attr("fill", "none")
    .attr("stroke", "var(--border)")
    .attr("stroke-width", 1)
    .attr("pointer-events", "none");

  // ── Axes groups (outside zoom group, stay fixed) ──────────────────────
  mapSvg.append("g").attr("id", "map-x-axis")
    .attr("class", "axis")
    .attr("transform", `translate(0, ${PLOT_MARGIN.top + PLOT_H})`);

  mapSvg.append("g").attr("id", "map-y-axis")
    .attr("class", "axis")
    .attr("transform", `translate(${PLOT_MARGIN.left}, 0)`);

  // ── Plot title (fixed) ────────────────────────────────────────────────
  mapSvg.append("text")
    .attr("id", "map-title")
    .attr("class", "plot-title")
    .attr("x", PLOT_MARGIN.left + PLOT_W / 2)
    .attr("y", 25)
    .attr("text-anchor", "middle");

  // ── Colorbar group (fixed, outside zoom group) ────────────────────────
  const cbarG = mapSvg.append("g").attr("id", "map-colorbar");
  const cbarX = PLOT_MARGIN.left + PLOT_W + 18;
  const cbarW = 14;

  cbarG.append("rect")
    .attr("id", "cbar-rect")
    .attr("x", cbarX)
    .attr("y", PLOT_MARGIN.top)
    .attr("width", cbarW)
    .attr("height", PLOT_H)
    .attr("stroke", "var(--border)")
    .attr("stroke-width", 0.5);

  cbarG.append("g")
    .attr("id", "cbar-axis")
    .attr("class", "axis")
    .attr("transform", `translate(${cbarX + cbarW}, 0)`);

  cbarG.append("text")
    .attr("id", "cbar-label")
    .attr("class", "axis-label")
    .attr("x", cbarX + cbarW + 42)
    .attr("y", PLOT_MARGIN.top + PLOT_H / 2)
    .attr("transform", `rotate(90, ${cbarX + cbarW + 42}, ${PLOT_MARGIN.top + PLOT_H / 2})`)
    .attr("text-anchor", "middle")
    .text("Temperature Difference (°C)");

  // ── d3.zoom setup ─────────────────────────────────────────────────────
  // Transparent hit-area rect covering ONLY the plot region.
  // Zoom/pan events are captured here so the surrounding margin space
  // (axes, colorbar, title) does not respond to scroll or drag.
  const zoomHitRect = mapSvg.append("rect")
    .attr("id", "zoom-hit-rect")
    .attr("x", PLOT_MARGIN.left)
    .attr("y", PLOT_MARGIN.top)
    .attr("width", PLOT_W)
    .attr("height", PLOT_H)
    .attr("fill", "transparent")   // invisible but pointer-events-active
    .style("cursor", "grab");

  mapZoom = d3.zoom()
    // extent() tells d3.zoom the viewport bounds in SVG coordinates.
    // Without this, d3.zoom falls back to [clientWidth, clientHeight] of the
    // element, which is 0 for an SVG <rect>, causing a non-identity transform
    // at scale=1 that visually misaligns the map when first loaded or fully zoomed out.
    .extent([
      [PLOT_MARGIN.left, PLOT_MARGIN.top],
      [PLOT_MARGIN.left + PLOT_W, PLOT_MARGIN.top + PLOT_H]
    ])
    .scaleExtent([1, 16])
    // translateExtent keeps panning bounded — the content edges can't scroll
    // outside the viewport bounds defined above.
    .translateExtent([
      [PLOT_MARGIN.left, PLOT_MARGIN.top],
      [PLOT_MARGIN.left + PLOT_W, PLOT_MARGIN.top + PLOT_H]
    ])
    .on("start", (event) => {
      updateLastMousePosFromEvent(event);
      isZoomingOrPanning = true;
      d3.select("#tooltip").classed("hidden", true);
      zoomHitRect.style("cursor", "grabbing");
    })
    .on("zoom", (event) => {
      updateLastMousePosFromEvent(event);
      d3.select("#map-zoom-group").attr("transform", event.transform);
    })
    .on("end", (event) => {
      updateLastMousePosFromEvent(event);
      isZoomingOrPanning = false;
      zoomHitRect.style("cursor", "grab");
      updateTooltip();
    });

  // Apply zoom to the hit rect, NOT the full SVG
  zoomHitRect.call(mapZoom);

  // Prevent browser window scrolling when wheeling/zooming over the scrollable map area
  zoomHitRect.node().addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );

  // Double-click on the plot area resets zoom
  zoomHitRect.on("dblclick.zoom", () => {
    zoomHitRect.transition().duration(400).call(mapZoom.transform, d3.zoomIdentity);
  });

  // Remove the default cursor style we set on the SVG itself
  mapSvg.style("cursor", null);

  // ── Hover tooltip (details-on-demand) ─────────────────────────────────
  // The map is a raster image, so there are no per-cell elements to hover.
  // Instead we read the mouse position over the plot, undo the current zoom
  // transform, convert plot pixels -> lon/lat, and look up the diff value.
  zoomHitRect
    .on("mousemove", (event) => {
      updateLastMousePosFromEvent(event);
      updateTooltip();
    })
    .on("mouseleave", () => {
      lastMousePos = null;
      d3.select("#tooltip").classed("hidden", true);
    });
}

function updateTooltip() {
  const tooltip = d3.select("#tooltip");
  if (!lastMousePos || !currentDiff || isZoomingOrPanning) {
    tooltip.classed("hidden", true);
    return;
  }

  // Mouse position in SVG coordinates
  const [mx, my] = d3.pointer(lastMousePos, mapSvg.node());

  // Undo the zoom/pan transform so we get the position on the un-zoomed map
  const hitNode = document.getElementById("zoom-hit-rect");
  if (!hitNode) return;
  const t = d3.zoomTransform(hitNode);
  const px = (mx - t.x) / t.k;
  const py = (my - t.y) / t.k;

  // Fraction across the plot area (0..1)
  const fx = (px - PLOT_MARGIN.left) / PLOT_W;
  const fy = (py - PLOT_MARGIN.top)  / PLOT_H;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
    tooltip.classed("hidden", true);
    return;
  }

  const { diff, lats, lons } = currentDiff;
  const nLats = lats.length;
  const nLons = lons.length;

  // fy=0 is the top of the plot (North). Row 0 of diff is the southernmost
  // lat, so flip: top of plot -> last row.
  const rowFromTop = Math.min(nLats - 1, Math.floor(fy * nLats));
  const r = (nLats - 1) - rowFromTop;

  // The image is drawn with longitudes shifted by 180° (center = lon 0).
  // Undo that shift to get the source column in the diff grid.
  const halfCols = Math.floor(nLons / 2);
  const xCol = Math.min(nLons - 1, Math.floor(fx * nLons));
  const srcCol = (xCol + halfCols) % nLons;

  const val = diff[r][srcCol];
  const lat = lats[r];
  let lon = lons[srcCol];
  if (lon > 180) lon -= 360;   // show -180..180 instead of 0..360

  // Position the tooltip using real pixel coords inside #map-container.
  // (mx/my are viewBox units, which differ from on-screen pixels.)
  const container = document.getElementById("map-container");
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const cx = lastMousePos.clientX - rect.left;
  const cy = lastMousePos.clientY - rect.top;

  const tempColor = val > 0 ? "#dc2626" : "var(--accent)";
  tooltip
    .classed("hidden", false)
    .style("left", (cx + 14) + "px")
    .style("top",  (cy + 14) + "px")
    .html(
      `<strong class="${val > 0 ? "pos" : "neg"}" style="color: ${tempColor};">${val >= 0 ? "+" : ""}${val.toFixed(2)} °C</strong>` +
      `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? "N" : "S"}, ` +
      `${Math.abs(lon).toFixed(0)}°${lon >= 0 ? "E" : "W"}`
    );
}

// ── Map update (raster heatmap similar to matplotlib .plot()) ──────────────────
function getGrid(scenario, year) {
  if (!appData.isBinary) {
    return appData.data[scenario]?.[String(year)] ?? null;
  }
  const sIdx = appData.scenariosList.indexOf(scenario);
  const yIdx = year - appData.meta.years[0];
  if (sIdx === -1 || yIdx < 0 || yIdx >= appData.meta.years.length) return null;
  const nLats = appData.meta.lats.length;
  const nLons = appData.meta.lons.length;
  const start = (sIdx * appData.meta.years.length + yIdx) * (nLats * nLons);
  const raw = appData.binaryData;
  const scale = appData.scale || 100;
  const grid = new Array(nLats);
  for (let r = 0; r < nLats; r++) {
    const row = new Float32Array(nLons);
    const rowStart = start + r * nLons;
    for (let c = 0; c < nLons; c++) {
      row[c] = raw[rowStart + c] / scale;
    }
    grid[r] = row;
  }
  return grid;
}

function computeDiff(year) {
  const { lats, lons } = appData.meta;
  const nLats = lats.length;
  const nLons = lons.length;

  if (appData.isBinary) {
    const sA = appData.scenariosList.indexOf(scenarioA);
    const sB = appData.scenariosList.indexOf(scenarioB);
    const yIdx = year - appData.meta.years[0];
    if (sA === -1 || sB === -1 || yIdx < 0 || yIdx >= appData.meta.years.length) return null;

    const startA = (sA * appData.meta.years.length + yIdx) * (nLats * nLons);
    const startB = (sB * appData.meta.years.length + yIdx) * (nLats * nLons);
    const raw = appData.binaryData;
    const scale = appData.scale || 100;

    const diff = new Array(nLats);
    for (let r = 0; r < nLats; r++) {
      const row = new Float32Array(nLons);
      const rowStartA = startA + r * nLons;
      const rowStartB = startB + r * nLons;
      for (let c = 0; c < nLons; c++) {
        row[c] = (raw[rowStartA + c] - raw[rowStartB + c]) / scale;
      }
      diff[r] = row;
    }
    return { diff, lats, lons };
  } else {
    const A = getGrid(scenarioA, year);
    const B = getGrid(scenarioB, year);
    if (!A || !B) return null;

    const diff = [];
    for (let i = 0; i < lats.length; i++) {
      const row = new Float32Array(nLons);
      for (let j = 0; j < nLons; j++) {
        row[j] = A[i][j] - B[i][j];
      }
      diff.push(row);
    }
    return { diff, lats, lons };
  }
}

// Largest |A − B| across ALL years for the current scenario pair.
// Cached per scenario pair so the colour scale stays FIXED while scrubbing
// the year — early years read pale, late years saturate, so the viewer can
// see the divergence grow instead of every year being auto-rescaled.
let scaleAbsMax = null;
let scaleAbsMaxKey = null;

function getFixedAbsMax() {
  const key = `${scenarioA}|${scenarioB}`;
  if (key === scaleAbsMaxKey && scaleAbsMax != null) return scaleAbsMax;

  const { years } = appData.meta;
  let maxAbs = 0.5;   // floor so a near-zero pair still has a usable scale
  for (let y = 0; y < years.length; y++) {
    const res = computeDiff(years[y]);
    if (!res) continue;
    const { diff } = res;
    for (let r = 0; r < diff.length; r++) {
      const row = diff[r];
      for (let c = 0; c < row.length; c++) {
        const a = Math.abs(row[c]);
        if (a > maxAbs) maxAbs = a;
      }
    }
  }
  scaleAbsMaxKey = key;
  scaleAbsMax = maxAbs;
  return maxAbs;
}

function updateMap() {
  const result = computeDiff(currentYear);
  if (!result) return;

  currentDiff = result;   // keep for tooltip lookups
  updateTooltip();

  const { diff, lats, lons } = result;

  // Fixed diverging colormap (same scale across all years for this pair)
  let domain;
  const absMax = getFixedAbsMax();
  colorScale = d3.scaleDiverging(t => d3.interpolateRdBu(1 - t)).domain([-absMax, 0, absMax]);
  domain = [-absMax, absMax];

  // 1. Draw raw grid onto an offscreen canvas
  // Shift longitudes by 180° so (lon: 0, lat: 0) is at the exact center of the map
  const nRows = diff.length;       // 48 (lats)
  const nCols = diff[0].length;    // 72 (lons)
  const halfCols = Math.floor(nCols / 2);

  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = nCols;
  rawCanvas.height = nRows;
  const rawCtx = rawCanvas.getContext("2d");
  const imgData = rawCtx.createImageData(nCols, nRows);
  const pixels = imgData.data;

  for (let y = 0; y < nRows; y++) {
    // In canvas, y=0 is the top (North pole / Arctic, index nRows-1)
    const r = (nRows - 1) - y;
    for (let x = 0; x < nCols; x++) {
      // Cyclically shift longitude by 180° (halfCols):
      // x=0 is -180°, x=halfCols is 0° (center), x=nCols-1 is +180°
      const srcCol = (x + halfCols) % nCols;
      const val = diff[r][srcCol];
      const rgb = d3.rgb(colorScale(val));
      const idx = (y * nCols + x) * 4;
      pixels[idx]     = rgb.r;
      pixels[idx + 1] = rgb.g;
      pixels[idx + 2] = rgb.b;
      pixels[idx + 3] = 255;
    }
  }

  rawCtx.putImageData(imgData, 0, 0);

  // High-res bicubic/bilinear smoothing (similar to matplotlib's interpolation)
  const hiResCanvas = document.createElement("canvas");
  hiResCanvas.width = PLOT_W * 2;   // 2x Retina resolution
  hiResCanvas.height = PLOT_H * 2;
  const hiResCtx = hiResCanvas.getContext("2d");
  hiResCtx.imageSmoothingEnabled = true;
  hiResCtx.imageSmoothingQuality = "high";
  hiResCtx.drawImage(rawCanvas, 0, 0, hiResCanvas.width, hiResCanvas.height);

  // Set image href
  d3.select("#plot-image").attr("href", hiResCanvas.toDataURL());

  // 2. Update Title
  d3.select("#map-title")
    .text(`Temperature Difference: ${scenarioA.toUpperCase()} − ${scenarioB.toUpperCase()} (${currentYear})`);

  // 3. Update Colorbar
  updatePlotColorbar(domain);
}

function updatePlotColorbar(domain) {
  const [dMin, dMax] = domain;
  const defs = mapSvg.select("defs");
  defs.select("#plot-cbar-grad").remove();

  const grad = defs.append("linearGradient")
    .attr("id", "plot-cbar-grad")
    .attr("x1", "0%").attr("y1", "100%")
    .attr("x2", "0%").attr("y2", "0%");

  const nStops = 100;
  for (let i = 0; i <= nStops; i++) {
    const t = i / nStops;
    const val = dMin + t * (dMax - dMin);
    grad.append("stop")
      .attr("offset", `${t * 100}%`)
      .attr("stop-color", colorScale(val));
  }

  d3.select("#cbar-rect").attr("fill", "url(#plot-cbar-grad)");

  const cbarScale = d3.scaleLinear()
    .domain([dMin, dMax])
    .range([PLOT_MARGIN.top + PLOT_H, PLOT_MARGIN.top]);

  const cbarAxis = d3.axisRight(cbarScale)
    .ticks(6)
    .tickFormat(d => `${d >= 0 ? "" : ""}${d.toFixed(1)}`);

  d3.select("#cbar-axis").call(cbarAxis);
}

// ── Band Chart ───────────────────────────────────────────────────────────
function buildBandChart() {
  bandSvg = d3.select("#band-chart");
}

function updateBandChart() {
  const result = computeDiff(currentYear);
  if (!result) return;

  const { diff, lats, lons } = result;
  const nLon = lons.length;

  // Area-weight within each band by cos(lat)
  function bandMean(lo, hi) {
    let sumW = 0, sumV = 0;
    for (let i = 0; i < lats.length; i++) {
      const lat = lats[i];
      if (lat < lo || lat >= hi) continue;
      const w = Math.cos(lat * Math.PI / 180);
      for (let j = 0; j < nLon; j++) {
        sumV += diff[i][j] * w;
        sumW += w;
      }
    }
    return sumW > 0 ? sumV / sumW : 0;
  }

  const data = BANDS.map(b => ({
    label: b.label,
    value: bandMean(b.lo, b.hi),
  }));

  const svgEl = bandSvg.node();
  const W = svgEl.clientWidth  || 208;
  const H = svgEl.clientHeight || 220;
  bandSvg.attr("viewBox", `0 0 ${W} ${H}`);

  // Reserve 62px on the left for the widest label (e.g. "90°S–60°S"), and 42px on the right for values
  const margin = { top: 8, right: 42, bottom: 8, left: 62 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top  - margin.bottom;

  const absMax = Math.max(0.1, d3.max(data, d => Math.abs(d.value)));
  const xScale = d3.scaleLinear().domain([-absMax, absMax]).range([0, iW]);
  const yScale = d3.scaleBand()
    .domain(data.map(d => d.label))
    .range([0, iH])
    .padding(0.28);

  bandSvg.selectAll("*").remove();
  const g = bandSvg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // Zero line
  g.append("line")
    .attr("x1", xScale(0)).attr("x2", xScale(0))
    .attr("y1", 0).attr("y2", iH)
    .attr("stroke", "var(--border)")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "2,2");

  // Bars
  g.selectAll("rect")
    .data(data)
    .join("rect")
    .attr("y", d => yScale(d.label))
    .attr("height", yScale.bandwidth())
    .attr("x", d => d.value >= 0 ? xScale(0) : xScale(d.value))
    .attr("width", d => Math.max(1, Math.abs(xScale(d.value) - xScale(0))))
    .attr("fill", d => d.value >= 0 ? "var(--tagA)" : "var(--tagB)")
    .attr("rx", 2);

  // Value labels (right-aligned against right boundary)
  g.selectAll("text.val")
    .data(data)
    .join("text")
    .attr("class", "val")
    .attr("y", d => yScale(d.label) + yScale.bandwidth() / 2 + 4)
    .attr("x", iW + margin.right - 2)
    .attr("text-anchor", "end")
    .attr("fill", d => d.value >= 0 ? "var(--tagA)" : "var(--tagB)")
    .attr("font-size", "0.68rem")
    .attr("font-weight", "600")
    .text(d => `${d.value > 0 ? "+" : ""}${d.value.toFixed(2)}°`);

  // Y axis labels (left-aligned starting at 2px from the SVG edge, never cut off)
  g.selectAll("text.band")
    .data(data)
    .join("text")
    .attr("class", "band")
    .attr("x", -margin.left + 2)
    .attr("y", d => yScale(d.label) + yScale.bandwidth() / 2 + 4)
    .attr("text-anchor", "start")
    .attr("fill", "var(--textSec)")
    .attr("font-size", "0.66rem")
    .text(d => d.label);
}

// ── Global mean ──────────────────────────────────────────────────────────
function updateGlobalMean() {
  const result = computeDiff(currentYear);
  if (!result) return;

  const { diff, lats, lons } = result;
  const nLon = lons.length;

  let sumW = 0, sumV = 0;
  for (let i = 0; i < lats.length; i++) {
    const w = Math.cos(lats[i] * Math.PI / 180);
    for (let j = 0; j < nLon; j++) {
      sumV += diff[i][j] * w;
      sumW += w;
    }
  }
  const mean = sumW > 0 ? sumV / sumW : 0;
  const el = document.getElementById("global-mean-value");
  el.textContent = `${mean > 0 ? "+" : ""}${mean.toFixed(2)}`;
  el.style.color = mean > 0 ? "var(--tagA)" : mean < -0.05 ? "var(--tagB)" : "var(--accent)";
}

// ── Time series ──────────────────────────────────────────────────────────
function buildTimeSeries() {
  const svgEl = document.getElementById("ts-svg");
  const W = svgEl.clientWidth || 900;
  const H = 160;
  tsSvg = d3.select("#ts-svg")
    .attr("viewBox", `0 0 ${W} ${H}`);

  const margin = { top: 10, right: 20, bottom: 28, left: 44 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top  - margin.bottom;

  const { years } = appData.meta;

  // Global mean temperature for each scenario over all years
  function scenarioGlobalMeans(expId) {
    const lats = appData.meta.lats;
    const nLats = lats.length;
    const nLons = appData.meta.lons.length;
    const weights = new Float32Array(nLats);
    let totalWeight = 0;
    for (let i = 0; i < nLats; i++) {
      weights[i] = Math.cos(lats[i] * Math.PI / 180);
      totalWeight += weights[i] * nLons;
    }

    if (appData.isBinary) {
      const sIdx = appData.scenariosList.indexOf(expId);
      const raw = appData.binaryData;
      const scale = appData.scale || 100;
      return years.map((year, yIdx) => {
        const start = (sIdx * years.length + yIdx) * (nLats * nLons);
        let sum = 0;
        for (let r = 0; r < nLats; r++) {
          const w = weights[r];
          const rowStart = start + r * nLons;
          let rowSum = 0;
          for (let c = 0; c < nLons; c++) {
            rowSum += raw[rowStart + c];
          }
          sum += (rowSum / scale) * w;
        }
        return { year, val: sum / totalWeight };
      });
    } else {
      return years.map(year => {
        const grid = getGrid(expId, year);
        if (!grid) return { year, val: NaN };
        let sum = 0;
        for (let i = 0; i < nLats; i++) {
          const w = weights[i];
          let rowSum = 0;
          for (let j = 0; j < nLons; j++) {
            rowSum += grid[i][j];
          }
          sum += rowSum * w;
        }
        return { year, val: sum / totalWeight };
      });
    }
  }

  const scenarios = Object.keys(appData.meta.scenarios);
  const seriesData = {};
  scenarios.forEach(id => { seriesData[id] = scenarioGlobalMeans(id); });

  // y domain: across all scenarios
  const allVals = scenarios.flatMap(id => seriesData[id].map(d => d.val)).filter(v => !isNaN(v));
  const yMin = d3.min(allVals) - 0.3;
  const yMax = d3.max(allVals) + 0.3;

  const xScale = d3.scaleLinear().domain([years[0], years[years.length - 1]]).range([0, iW]);
  const yScale = d3.scaleLinear().domain([yMin, yMax]).range([iH, 0]);
  tsScales = { x: xScale, y: yScale, margin, iH };

  const g = tsSvg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // Grid lines
  g.append("g")
    .attr("class", "axis grid")
    .attr("transform", `translate(0,${iH})`)
    .call(
      d3.axisBottom(xScale)
        .ticks(8)
        .tickSize(-iH)
        .tickFormat(d3.format("d"))
    )
    .call(gg => gg.selectAll(".tick line").attr("stroke", "rgba(255,255,255,0.05)"))
    .call(gg => gg.select(".domain").remove());

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(yScale).ticks(4).tickFormat(d => `${d.toFixed(0)}°`))
    .call(gg => gg.select(".domain").remove());

  // Lines
  const line = d3.line().x(d => xScale(d.year)).y(d => yScale(d.val)).curve(d3.curveMonotoneX);

  scenarios.forEach(id => {
    g.append("path")
      .datum(seriesData[id])
      .attr("fill", "none")
      .attr("stroke", SCENARIO_COLORS[id] || "#888")
      .attr("stroke-width", 2)
      .attr("opacity", 0.9)
      .attr("d", line);
  });

  // Year marker line (vertical, draggable by the slider)
  yearLineG = g.append("g").attr("class", "year-marker");
  yearLineG.append("line")
    .attr("class", "year-line")
    .attr("y1", 0).attr("y2", iH);

  // Legend
  const legendEl = document.getElementById("ts-legend");
  legendEl.innerHTML = "";
  scenarios.forEach(id => {
    const item = document.createElement("div");
    item.className = "ts-legend-item";
    item.innerHTML = `
      <div class="ts-legend-swatch" style="background:${SCENARIO_COLORS[id] || '#888'}"></div>
      <span>${appData.meta.scenarios[id]}</span>
    `;
    legendEl.appendChild(item);
  });
}

function updateTimeSeries() {
  if (!tsScales) return;
  const { x } = tsScales;
  yearLineG.select("line")
    .attr("x1", x(currentYear))
    .attr("x2", x(currentYear));
}

// ── Main update ──────────────────────────────────────────────────────────
function update() {
  updateMap();
  updateBandChart();
  updateGlobalMean();
  updateTimeSeries();
}

// ── Play animation ───────────────────────────────────────────────────────
const BASE_INTERVAL = 300;   // ms per year at 1× speed
let playSpeed = 1;           // 1 or 2 (×)

function stopPlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  const btn = document.getElementById("btn-play");
  btn.innerHTML = '<span class="btn-icon">▶</span> Play';
  btn.classList.remove("playing");
}

function startPlayTimer() {
  const { years } = appData.meta;
  const lastYear = years[years.length - 1];
  const slider = document.getElementById("year-slider");

  playTimer = setInterval(() => {
    if (currentYear >= lastYear) { stopPlay(); return; }  // play to the end, then stop
    currentYear += 1;
    slider.value = currentYear;
    document.getElementById("year-display").textContent = currentYear;
    update();
  }, BASE_INTERVAL / playSpeed);
}

function togglePlay() {
  if (playTimer) { stopPlay(); return; }

  const { years } = appData.meta;
  const lastYear = years[years.length - 1];

  // If we're sitting at the end, pressing Play restarts from the first year
  if (currentYear >= lastYear) {
    currentYear = years[0];
    document.getElementById("year-slider").value = currentYear;
    document.getElementById("year-display").textContent = currentYear;
    update();
  }

  const btn = document.getElementById("btn-play");
  btn.innerHTML = '<span class="btn-icon pause-icon">▐▐</span> Pause';
  btn.classList.add("playing");
  startPlayTimer();
}

// ── Overlay & Progress helpers ──────────────────────────────────────────
function updateProgress(loaded, total, statusText) {
  const el = document.getElementById("overlay");
  el.classList.remove("hidden");

  const msgEl = document.getElementById("overlay-msg");
  if (statusText) msgEl.textContent = statusText;

  const pBar = document.getElementById("progress-bar");
  const pDetails = document.getElementById("progress-details");
  const pContainer = document.getElementById("progress-container");

  if (pContainer) pContainer.style.display = "block";
  if (pDetails) pDetails.style.display = "block";

  const safeTotal = Math.max(1, total || 38043648);
  const clampedLoaded = Math.min(loaded, safeTotal);
  const pct = Math.min(100, Math.max(0, Math.round((clampedLoaded / safeTotal) * 100)));

  if (pBar) {
    pBar.style.width = `${pct}%`;
  }

  if (pDetails) {
    pDetails.textContent = `${pct}%`;
  }
}

function showOverlay(msg, isError = false) {
  const el = document.getElementById("overlay");
  const msgEl = document.getElementById("overlay-msg");
  const spin = document.getElementById("spinner");
  const pContainer = document.getElementById("progress-container");
  const pDetails = document.getElementById("progress-details");

  el.classList.remove("hidden");
  msgEl.style.whiteSpace = "pre-wrap";
  msgEl.textContent = msg;
  spin.style.display = isError ? "none" : "block";

  if (isError) {
    if (pContainer) pContainer.style.display = "none";
    if (pDetails) pDetails.style.display = "none";
  }
}

function hideOverlay() {
  document.getElementById("overlay").classList.add("hidden");
}

// ── Entry point ──────────────────────────────────────────────────────────
init();
