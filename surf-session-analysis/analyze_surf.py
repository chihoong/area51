#!/usr/bin/env python3
"""Analyze a surf session GPX file and produce a detailed report + HTML map."""

import xml.etree.ElementTree as ET
from datetime import datetime, timezone
import math
import json
import sys

GPX_FILE = "/Users/chi-hoongkok/Documents/Anthropic/surf/20260328_Morning_Surf.gpx"
OUT_HTML  = "/Users/chi-hoongkok/Documents/Anthropic/surf/surf_report.html"

NS = {"gpx": "http://www.topografix.com/GPX/1/1"}

# ── helpers ──────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    """Return distance in metres between two lat/lon points."""
    R = 6_371_000
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    dφ = math.radians(lat2 - lat1)
    dλ = math.radians(lon2 - lon1)
    a = math.sin(dφ/2)**2 + math.cos(φ1)*math.cos(φ2)*math.sin(dλ/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def bearing(lat1, lon1, lat2, lon2):
    """Return bearing in degrees (0=N, 90=E, 180=S, 270=W)."""
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    dλ = math.radians(lon2 - lon1)
    x = math.sin(dλ) * math.cos(φ2)
    y = math.cos(φ1)*math.sin(φ2) - math.sin(φ1)*math.cos(φ2)*math.cos(dλ)
    return (math.degrees(math.atan2(x, y)) + 360) % 360

def smooth(values, window=3):
    out = []
    for i in range(len(values)):
        lo = max(0, i - window//2)
        hi = min(len(values), i + window//2 + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out

# ── parse GPX ────────────────────────────────────────────────────────────────

tree = ET.parse(GPX_FILE)
root = tree.getroot()

pts = []
for tp in root.findall(".//gpx:trkpt", NS):
    lat = float(tp.attrib["lat"])
    lon = float(tp.attrib["lon"])
    t   = tp.find("gpx:time", NS)
    if t is None:
        continue
    ts = datetime.fromisoformat(t.text.replace("Z", "+00:00"))
    pts.append({"lat": lat, "lon": lon, "ts": ts})

print(f"Loaded {len(pts)} track points")
print(f"Session start : {pts[0]['ts']}")
print(f"Session end   : {pts[-1]['ts']}")
total_duration = (pts[-1]['ts'] - pts[0]['ts']).total_seconds()
print(f"Total duration: {total_duration/60:.1f} min")

# ── compute per-point speed & bearing ────────────────────────────────────────

for i in range(len(pts)):
    if i == 0:
        pts[i]["speed_ms"] = 0.0
        pts[i]["bearing"]  = 0.0
    else:
        dt = (pts[i]["ts"] - pts[i-1]["ts"]).total_seconds()
        if dt <= 0:
            pts[i]["speed_ms"] = pts[i-1]["speed_ms"]
            pts[i]["bearing"]  = pts[i-1]["bearing"]
        else:
            d = haversine(pts[i-1]["lat"], pts[i-1]["lon"], pts[i]["lat"], pts[i]["lon"])
            pts[i]["speed_ms"] = d / dt
            pts[i]["bearing"]  = bearing(pts[i-1]["lat"], pts[i-1]["lon"],
                                          pts[i]["lat"],   pts[i]["lon"])

speeds = [p["speed_ms"] for p in pts]
speeds_smooth = smooth(speeds, window=5)
for i, p in enumerate(pts):
    p["speed_smooth"] = speeds_smooth[i]

# ── determine shore bearing ───────────────────────────────────────────────────
# Use the median lat to find rough centre; shore is roughly east of lineup
# We'll estimate it from the data: the most common high-speed bearing is shoreward.
# At Seal Beach / Long Beach area the shoreline runs ~NW-SE.
# Shoreward = roughly east (~90°). We'll derive it from the data automatically.

# Collect bearings during "fast" moments (>3 m/s) — these are mostly rides.
fast_bearings = [p["bearing"] for p in pts if p["speed_smooth"] > 3.0]
if fast_bearings:
    # Circular mean
    sin_sum = sum(math.sin(math.radians(b)) for b in fast_bearings)
    cos_sum = sum(math.cos(math.radians(b)) for b in fast_bearings)
    shore_bearing = (math.degrees(math.atan2(sin_sum, cos_sum)) + 360) % 360
else:
    shore_bearing = 90.0  # default east

print(f"Estimated shore bearing: {shore_bearing:.1f}°")

# ── wave detection ────────────────────────────────────────────────────────────
# A wave ride = sustained period where speed > threshold AND bearing is
# roughly shoreward (within ±70° of shore_bearing).

SPEED_THRESHOLD = 2.5   # m/s  (~9 km/h) — minimum ride speed
MIN_WAVE_SECS   = 5     # ignore blips shorter than this
MAX_GAP_SECS    = 3     # allow short dips to bridge wave segments

def is_shoreward(b, shore_b, tol=75):
    diff = abs((b - shore_b + 180) % 360 - 180)
    return diff < tol

in_wave = False
wave_start = None
wave_buf   = []
waves_raw  = []

for i, p in enumerate(pts):
    riding = p["speed_smooth"] > SPEED_THRESHOLD and is_shoreward(p["bearing"], shore_bearing)
    if riding:
        if not in_wave:
            in_wave = True
            wave_start = i
            wave_buf = [i]
        else:
            wave_buf.append(i)
    else:
        if in_wave:
            # check gap tolerance
            gap = p["ts"] - pts[wave_buf[-1]]["ts"] if wave_buf else None
            if gap and gap.total_seconds() <= MAX_GAP_SECS:
                wave_buf.append(i)  # bridge small gap
            else:
                in_wave = False
                dur = (pts[wave_buf[-1]]["ts"] - pts[wave_buf[0]]["ts"]).total_seconds()
                if dur >= MIN_WAVE_SECS:
                    waves_raw.append(wave_buf[:])
                wave_buf = []

# flush last wave
if in_wave and wave_buf:
    dur = (pts[wave_buf[-1]]["ts"] - pts[wave_buf[0]]["ts"]).total_seconds()
    if dur >= MIN_WAVE_SECS:
        waves_raw.append(wave_buf[:])

print(f"Raw wave candidates: {len(waves_raw)}")

# ── characterise each wave ────────────────────────────────────────────────────

def wave_direction(indices):
    """
    Determine if the wave is a LEFT or RIGHT.
    For a surfer facing shore, a right = surfer moves to their right =
    bearing tilts to the right of the shore bearing.
    Shore bearing ~90° (east).
      - Right: bearing < shore_bearing (e.g. NE) means moving northward along shore = Right for surfer facing east
      - Left:  bearing > shore_bearing (e.g. SE) means moving southward = Left
    We use the lateral component of movement.
    """
    lats = [pts[i]["lat"] for i in indices]
    # If lat increases (moving north) while going shoreward → right-hander at this beach
    lat_delta = lats[-1] - lats[0]
    if lat_delta > 0.000005:
        return "Right"
    elif lat_delta < -0.000005:
        return "Left"
    else:
        return "Straight"

waves = []
for idx, buf in enumerate(waves_raw):
    lats = [pts[i]["lat"] for i in buf]
    lons = [pts[i]["lon"] for i in buf]
    spds = [pts[i]["speed_smooth"] for i in buf]

    start_pt = pts[buf[0]]
    end_pt   = pts[buf[-1]]
    duration = (end_pt["ts"] - start_pt["ts"]).total_seconds()

    # total distance along track
    dist = sum(
        haversine(pts[buf[j-1]]["lat"], pts[buf[j-1]]["lon"],
                  pts[buf[j]]["lat"],   pts[buf[j]]["lon"])
        for j in range(1, len(buf))
    )

    max_speed_ms  = max(spds)
    avg_speed_ms  = sum(spds) / len(spds)
    direction     = wave_direction(buf)

    waves.append({
        "num"          : idx + 1,
        "start_time"   : start_pt["ts"],
        "end_time"     : end_pt["ts"],
        "duration_s"   : duration,
        "distance_m"   : dist,
        "max_speed_ms" : max_speed_ms,
        "max_speed_kmh": max_speed_ms * 3.6,
        "avg_speed_kmh": avg_speed_ms * 3.6,
        "direction"    : direction,
        "start_lat"    : lats[0],
        "start_lon"    : lons[0],
        "end_lat"      : lats[-1],
        "end_lon"      : lons[-1],
        "track_lats"   : lats,
        "track_lons"   : lons,
    })

# ── summary stats ─────────────────────────────────────────────────────────────

n_waves  = len(waves)
n_rights = sum(1 for w in waves if w["direction"] == "Right")
n_lefts  = sum(1 for w in waves if w["direction"] == "Left")
n_str    = n_waves - n_rights - n_lefts

longest  = max(waves, key=lambda w: w["distance_m"]) if waves else None
fastest  = max(waves, key=lambda w: w["max_speed_kmh"]) if waves else None

print("\n" + "="*50)
print("SURF SESSION SUMMARY")
print("="*50)
print(f"Date          : {pts[0]['ts'].strftime('%Y-%m-%d')}")
print(f"Location      : {pts[0]['lat']:.5f}, {pts[0]['lon']:.5f}")
print(f"Duration      : {total_duration/60:.0f} min")
print(f"Total waves   : {n_waves}")
print(f"  Rights      : {n_rights}")
print(f"  Lefts       : {n_lefts}")
if longest:
    print(f"Longest wave  : Wave {longest['num']} — {longest['distance_m']:.0f} m")
if fastest:
    print(f"Top speed     : Wave {fastest['num']} — {fastest['max_speed_kmh']:.1f} km/h")
print()
print(f"{'#':>3}  {'Time':8}  {'Dir':6}  {'Dur':>6}  {'Dist':>7}  {'MaxSpd':>8}  {'AvgSpd':>8}")
print("-"*60)
for w in waves:
    t = w["start_time"].strftime("%H:%M:%S")
    print(f"{w['num']:>3}  {t}  {w['direction']:6}  {w['duration_s']:>5.0f}s  "
          f"{w['distance_m']:>6.0f}m  {w['max_speed_kmh']:>7.1f}kph  {w['avg_speed_kmh']:>7.1f}kph")

# ── build HTML map ────────────────────────────────────────────────────────────

centre_lat = sum(p["lat"] for p in pts) / len(pts)
centre_lon = sum(p["lon"] for p in pts) / len(pts)

# full track for background
full_track = [[p["lat"], p["lon"]] for p in pts]

# JSON for wave tracks
wave_data = []
for w in waves:
    wave_data.append({
        "num"      : w["num"],
        "dir"      : w["direction"],
        "dist_m"   : round(w["distance_m"]),
        "dur_s"    : round(w["duration_s"]),
        "max_kmh"  : round(w["max_speed_kmh"], 1),
        "avg_kmh"  : round(w["avg_speed_kmh"], 1),
        "track"    : list(zip(w["track_lats"], w["track_lons"])),
        "start"    : [w["start_lat"], w["start_lon"]],
    })

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Surf Session – {pts[0]['ts'].strftime('%Y-%m-%d')}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: #0a1628; color: #e0e8f0; }}
  h1   {{ padding: 16px 24px; font-size: 1.4rem; color: #7dd3fc;
           border-bottom: 1px solid #1e3a5f; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
            gap: 12px; padding: 16px 24px; }}
  .card {{ background: #0f2340; border: 1px solid #1e3a5f; border-radius: 10px;
            padding: 14px 18px; }}
  .card .label {{ font-size: .72rem; color: #7dd3fc; text-transform: uppercase;
                   letter-spacing: .06em; margin-bottom: 4px; }}
  .card .value {{ font-size: 1.7rem; font-weight: 700; color: #f0f8ff; }}
  .card .sub   {{ font-size: .8rem; color: #94a3b8; margin-top: 2px; }}
  #map {{ height: 420px; margin: 0 24px 16px; border-radius: 12px;
           border: 1px solid #1e3a5f; }}
  h2   {{ padding: 0 24px 10px; font-size: 1.1rem; color: #7dd3fc; }}
  table {{ width: calc(100% - 48px); margin: 0 24px 24px; border-collapse: collapse; }}
  th,td {{ padding: 8px 12px; text-align: left; font-size: .82rem; }}
  th   {{ background: #0f2340; color: #7dd3fc; border-bottom: 1px solid #1e3a5f; }}
  tr:nth-child(even) td {{ background: #0f2340; }}
  .right {{ color: #34d399; font-weight: 600; }}
  .left  {{ color: #f472b6; font-weight: 600; }}
  .straight {{ color: #fbbf24; font-weight: 600; }}
  .best {{ color: #fbbf24; }}
</style>
</head>
<body>
<h1>Morning Surf — {pts[0]['ts'].strftime('%d %B %Y')} &nbsp;|&nbsp; {pts[0]['lat']:.4f}°N {abs(pts[0]['lon']):.4f}°W</h1>
<div class="grid">
  <div class="card"><div class="label">Total Waves</div>
    <div class="value">{n_waves}</div>
    <div class="sub">Rights: {n_rights} &nbsp;|&nbsp; Lefts: {n_lefts}</div></div>
  <div class="card"><div class="label">Session Duration</div>
    <div class="value">{int(total_duration//60)}:{int(total_duration%60):02d}</div>
    <div class="sub">min:sec</div></div>
  <div class="card"><div class="label">Longest Wave</div>
    <div class="value">{longest['distance_m']:.0f} m</div>
    <div class="sub">Wave #{longest['num']} &nbsp;·&nbsp; {longest['duration_s']:.0f}s</div></div>
  <div class="card"><div class="label">Top Speed</div>
    <div class="value">{fastest['max_speed_kmh']:.1f} <span style="font-size:1rem">km/h</span></div>
    <div class="sub">Wave #{fastest['num']}</div></div>
</div>
<div id="map"></div>
<h2>Wave-by-Wave Breakdown</h2>
<table>
<thead><tr>
  <th>#</th><th>Time</th><th>Direction</th><th>Duration</th>
  <th>Distance</th><th>Top Speed</th><th>Avg Speed</th>
</tr></thead>
<tbody>
"""

for w in waves:
    dir_class = w["direction"].lower()
    best_dist = "best" if longest and w["num"] == longest["num"] else ""
    best_spd  = "best" if fastest and w["num"] == fastest["num"] else ""
    html += f"""<tr>
  <td>{w['num']}</td>
  <td>{w['start_time'].strftime('%H:%M:%S')}</td>
  <td class="{dir_class}">{w['direction']}</td>
  <td>{w['duration_s']:.0f}s</td>
  <td class="{best_dist}">{w['distance_m']:.0f} m</td>
  <td class="{best_spd}">{w['max_speed_kmh']:.1f} km/h</td>
  <td>{w['avg_speed_kmh']:.1f} km/h</td>
</tr>
"""

html += f"""</tbody></table>
<script>
const map = L.map('map').setView([{centre_lat}, {centre_lon}], 16);
L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
  attribution: '© OpenStreetMap contributors', maxZoom: 19
}}).addTo(map);

// full session track (faint)
const fullTrack = {json.dumps(full_track)};
L.polyline(fullTrack, {{color:'#334155', weight:1.5, opacity:0.5}}).addTo(map);

// waves
const waves = {json.dumps(wave_data)};
const colours = {{"Right":"#34d399","Left":"#f472b6","Straight":"#fbbf24"}};
waves.forEach(w => {{
  const col = colours[w.dir] || '#94a3b8';
  const line = L.polyline(w.track, {{color: col, weight: 4, opacity: 0.9}}).addTo(map);
  line.bindPopup(`<b>Wave ${{w.num}}</b><br>
    Direction: ${{w.dir}}<br>
    Distance: ${{w.dist_m}} m<br>
    Duration: ${{w.dur_s}}s<br>
    Top speed: ${{w.max_kmh}} km/h<br>
    Avg speed: ${{w.avg_kmh}} km/h`);
  // start dot
  L.circleMarker(w.start, {{radius:5, fillColor:col, color:'#fff',
    weight:1.5, fillOpacity:1}}).addTo(map)
    .bindTooltip(`W${{w.num}}`, {{permanent:true, direction:'top',
      className:'wave-label'}});
}});
</script>
<style>
.wave-label {{ background:transparent; border:none; box-shadow:none;
  color:#f0f8ff; font-size:.7rem; font-weight:700; }}
</style>
</body></html>"""

with open(OUT_HTML, "w") as f:
    f.write(html)

print(f"\nHTML report written to: {OUT_HTML}")
