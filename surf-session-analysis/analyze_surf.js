#!/usr/bin/env node
"use strict";

const fs   = require("fs");
const path = require("path");

const GPX_FILE = "/Users/chi-hoongkok/Documents/Anthropic/surf/20260328_Morning_Surf.gpx";
const OUT_HTML = "/Users/chi-hoongkok/Documents/Anthropic/surf/surf_report.html";

// ── timezone helpers ──────────────────────────────────────────────────────────
const TZ = "America/Los_Angeles";
function fmtTime(d){ return d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:TZ}); }
function fmtDate(d){ return d.toLocaleDateString("en-AU",{day:"2-digit",month:"long",year:"numeric",timeZone:TZ}); }

// ── geo helpers ───────────────────────────────────────────────────────────────
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000,φ1=lat1*Math.PI/180,φ2=lat2*Math.PI/180;
  const dφ=(lat2-lat1)*Math.PI/180,dλ=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function bearing(lat1,lon1,lat2,lon2){
  const φ1=lat1*Math.PI/180,φ2=lat2*Math.PI/180,dλ=(lon2-lon1)*Math.PI/180;
  const x=Math.sin(dλ)*Math.cos(φ2),y=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ);
  return((Math.atan2(x,y)*180/Math.PI)+360)%360;
}
function smooth(arr,w=5){
  return arr.map((_,i)=>{
    const lo=Math.max(0,i-Math.floor(w/2)),hi=Math.min(arr.length,i+Math.floor(w/2)+1);
    return arr.slice(lo,hi).reduce((a,b)=>a+b,0)/(hi-lo);
  });
}

// ── parse GPX ─────────────────────────────────────────────────────────────────
console.log("Reading GPX file…");
const xml = fs.readFileSync(GPX_FILE,"utf8");
const re  = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>[\s\S]*?<time>([^<]+)<\/time>/g;
const pts = []; let m;
while((m=re.exec(xml))!==null)
  pts.push({lat:parseFloat(m[1]),lon:parseFloat(m[2]),ts:new Date(m[3])});

console.log(`Loaded ${pts.length} track points`);
const sessionStart = pts[0].ts;
const sessionEnd   = pts[pts.length-1].ts;
const totalSec     = (sessionEnd - sessionStart)/1000;
console.log(`Session: ${sessionStart.toISOString()} → ${sessionEnd.toISOString()}`);
console.log(`Duration: ${(totalSec/60).toFixed(1)} min`);

// ── compute raw speed & bearing ───────────────────────────────────────────────
for(let i=0;i<pts.length;i++){
  if(i===0){pts[i].spd=0;pts[i].brg=0;continue;}
  const dt=(pts[i].ts-pts[i-1].ts)/1000;
  if(dt<=0){pts[i].spd=pts[i-1].spd;pts[i].brg=pts[i-1].brg;continue;}
  pts[i].spd=haversine(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon)/dt;
  pts[i].brg=bearing(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon);
}

// clamp GPS spikes: cap any single point exceeding 30 km/h (8.3 m/s) by
// checking if both neighbors are slow — GPS glitches produce isolated spikes
for(let i=1;i<pts.length-1;i++){
  const prev=pts[i-1].spd, next=pts[i+1].spd, cur=pts[i].spd;
  if(cur>8.3 && prev<5 && next<5) pts[i].spd=Math.max(prev,next); // glitch
}

// smooth speed with a 3-point median then 5-point mean
function median3(arr,i){
  const a=[arr[Math.max(0,i-1)],arr[i],arr[Math.min(arr.length-1,i+1)]].sort((a,b)=>a-b);
  return a[1];
}
const rawSpd    = pts.map(p=>p.spd);
const medSpd    = rawSpd.map((_,i)=>median3(rawSpd,i));
const smoothSpd = smooth(medSpd,5);
pts.forEach((p,i)=>p.spdS=smoothSpd[i]);

// ── shore bearing (from high-speed burst bearings) ────────────────────────────
// At Seal Beach / Long Beach, CA, shore runs ~NW-SE; shoreward ≈ ENE (~65°)
// Verify from data: top-speed moments averaged
const topBrgs = pts.filter(p=>p.spdS>4).map(p=>p.brg);
function circMean(angles){
  const sinS=angles.reduce((s,a)=>s+Math.sin(a*Math.PI/180),0);
  const cosS=angles.reduce((s,a)=>s+Math.cos(a*Math.PI/180),0);
  return((Math.atan2(sinS,cosS)*180/Math.PI)+360)%360;
}
const shoreBearing = topBrgs.length ? circMean(topBrgs) : 65;
// shore-parallel axis (perpendicular to shore) for L/R determination
const shoreParallel = (shoreBearing + 90) % 360; // ~155° or ~335°
console.log(`Shore bearing: ${shoreBearing.toFixed(1)}°`);

// ── wave detection ────────────────────────────────────────────────────────────
// A wave ride must:
//   • have smoothed speed > START_THRESH to begin
//   • have peak smoothed speed > PEAK_THRESH
//   • last >= MIN_DUR seconds (where speed > SUSTAIN_THRESH)
//   • gaps up to MAX_GAP allowed before committing end of wave
//
// We DON'T filter by direction here so we catch all rides; direction is
// classified afterwards as Left / Right.

function calcDist(buf){
  let d=0;
  for(let j=1;j<buf.length;j++)
    d+=haversine(pts[buf[j-1]].lat,pts[buf[j-1]].lon,pts[buf[j]].lat,pts[buf[j]].lon);
  return d;
}

const START_THRESH   = 12 / 3.6;  // 12 km/h → m/s
const SUSTAIN_THRESH = 10 / 3.6;  // 10 km/h
const PEAK_THRESH    = 15 / 3.6;  // 15 km/h minimum peak to count
const MIN_DUR        = 7;          // seconds
const MIN_DIST       = 35;         // metres — filters paddle bursts
const MAX_GAP        = 3;          // seconds gap bridging

let inWave=false, waveStart=-1, waveBuf=[], lastRideIdx=-1, wavesRaw=[];

for(let i=0;i<pts.length;i++){
  const riding = pts[i].spdS >= SUSTAIN_THRESH;
  if(riding){
    if(!inWave){ inWave=true; waveStart=i; waveBuf=[i]; }
    else waveBuf.push(i);
    lastRideIdx=i;
  } else {
    if(inWave){
      const gapSec = (pts[i].ts - pts[lastRideIdx].ts)/1000;
      if(gapSec <= MAX_GAP){
        waveBuf.push(i); // bridge small gap
      } else {
        inWave=false;
        const dur = (pts[waveBuf[waveBuf.length-1]].ts - pts[waveBuf[0]].ts)/1000;
        const peak = Math.max(...waveBuf.map(j=>pts[j].spdS));
        const dist=calcDist(waveBuf);
        if(dur >= MIN_DUR && peak >= PEAK_THRESH && dist >= MIN_DIST) wavesRaw.push([...waveBuf]);
        waveBuf=[];
        lastRideIdx=-1;
      }
    }
  }
}
// flush
if(inWave && waveBuf.length){
  const dur=(pts[waveBuf[waveBuf.length-1]].ts - pts[waveBuf[0]].ts)/1000;
  const peak=Math.max(...waveBuf.map(j=>pts[j].spdS));
  const dist=calcDist(waveBuf);
  if(dur>=MIN_DUR && peak>=PEAK_THRESH && dist>=MIN_DIST) wavesRaw.push([...waveBuf]);
}
console.log(`Wave candidates: ${wavesRaw.length}`);

// ── characterise waves ────────────────────────────────────────────────────────
// Direction: looking toward shore (bearing ~65°), left/right is determined by
// whether the surfer moves to their left or right while riding shoreward.
// At Seal Beach (shore runs NW-SE):
//   Moving northeast (brg ~15-65°) = riding toward NW = the surfer goes RIGHT
//   Moving southeast (brg ~65-135°) = riding toward SE = the surfer goes LEFT
// We classify by the dominant lateral component during the ride.

function waveDir(buf){
  // lateral displacement perpendicular to shore (positive = northward)
  const latStart = pts[buf[0]].lat, latEnd = pts[buf[buf.length-1]].lat;
  const latDelta = latEnd - latStart; // degrees
  // At this location, 1° lat ≈ 111km → 0.0001° ≈ 11m threshold
  if(Math.abs(latDelta) < 0.0001) return "Straight";
  // When moving shoreward (east), going north = Right hander, south = Left
  return latDelta > 0 ? "Right" : "Left";
}

const waves = wavesRaw.map((buf,idx)=>{
  const lats = buf.map(i=>pts[i].lat);
  const lons = buf.map(i=>pts[i].lon);
  const spds = buf.map(i=>pts[i].spdS);
  const dur  = (pts[buf[buf.length-1]].ts - pts[buf[0]].ts)/1000;
  let dist=0;
  for(let j=1;j<buf.length;j++)
    dist+=haversine(pts[buf[j-1]].lat,pts[buf[j-1]].lon,pts[buf[j]].lat,pts[buf[j]].lon);
  const maxSpd = Math.max(...spds);
  const avgSpd = spds.reduce((a,b)=>a+b,0)/spds.length;
  return {
    num:idx+1,
    startTime: pts[buf[0]].ts,
    endTime:   pts[buf[buf.length-1]].ts,
    durS:      dur,
    distM:     dist,
    maxSpdMs:  maxSpd,
    maxSpdKmh: maxSpd*3.6,
    avgSpdKmh: avgSpd*3.6,
    direction: waveDir(buf),
    startLat:  lats[0], startLon: lons[0],
    trackLats: lats, trackLons: lons,
  };
});

// ── summary stats ─────────────────────────────────────────────────────────────
const nWaves  = waves.length;
const nRights = waves.filter(w=>w.direction==="Right").length;
const nLefts  = waves.filter(w=>w.direction==="Left").length;
const longest = waves.reduce((a,b)=>b.distM>a.distM?b:a, waves[0]);
const fastest = waves.reduce((a,b)=>b.maxSpdKmh>a.maxSpdKmh?b:a, waves[0]);

console.log("\n"+"=".repeat(57));
console.log("SURF SESSION SUMMARY");
console.log("=".repeat(57));
console.log(`Date          : ${sessionStart.toISOString().slice(0,10)}`);
console.log(`Location      : ${pts[0].lat.toFixed(5)}, ${pts[0].lon.toFixed(5)}`);
console.log(`Duration      : ${Math.floor(totalSec/60)}m ${Math.floor(totalSec%60)}s`);
console.log(`Total waves   : ${nWaves}`);
console.log(`  Rights      : ${nRights}`);
console.log(`  Lefts       : ${nLefts}`);
console.log(`Longest wave  : Wave ${longest.num} — ${longest.distM.toFixed(0)} m  (${longest.durS.toFixed(0)}s)`);
console.log(`Top speed     : Wave ${fastest.num} — ${fastest.maxSpdKmh.toFixed(1)} km/h`);
console.log();
console.log(`${"#".padStart(3)}  ${"Time (PDT)".padEnd(9)}  ${"Dir".padEnd(8)}  ${"Dur".padStart(6)}  ${"Dist".padStart(7)}  ${"TopSpd".padStart(8)}  ${"AvgSpd".padStart(8)}`);
console.log("-".repeat(62));
waves.forEach(w=>{
  const t=fmtTime(w.startTime);
  console.log(
    `${String(w.num).padStart(3)}  ${t}  ${w.direction.padEnd(8)} `+
    ` ${w.durS.toFixed(0).padStart(4)}s  ${w.distM.toFixed(0).padStart(5)}m  `+
    `${w.maxSpdKmh.toFixed(1).padStart(6)}kph  ${w.avgSpdKmh.toFixed(1).padStart(6)}kph`
  );
});

// ── build HTML ────────────────────────────────────────────────────────────────
const centreLat = pts.reduce((s,p)=>s+p.lat,0)/pts.length;
const centreLon = pts.reduce((s,p)=>s+p.lon,0)/pts.length;
// Subsample full track for background (every 3rd point)
const fullTrack = pts.filter((_,i)=>i%3===0).map(p=>[p.lat,p.lon]);

const waveData = waves.map(w=>({
  num: w.num, dir: w.direction,
  distM: Math.round(w.distM), durS: Math.round(w.durS),
  maxKmh: +w.maxSpdKmh.toFixed(1), avgKmh: +w.avgSpdKmh.toFixed(1),
  track: w.trackLats.map((la,i)=>[la,w.trackLons[i]]),
  start: [w.startLat, w.startLon],
}));

const dateStr = fmtDate(sessionStart);
const durStr  = `${Math.floor(totalSec/60)}:${String(Math.floor(totalSec%60)).padStart(2,"0")}`;
const locStr  = `${pts[0].lat.toFixed(4)}°N  ${Math.abs(pts[0].lon).toFixed(4)}°W`;

let tableRows="";
waves.forEach(w=>{
  const cls    = w.direction.toLowerCase();
  const bDist  = w.num===longest.num ? ' class="best"' : "";
  const bSpd   = w.num===fastest.num ? ' class="best"' : "";
  tableRows+=`<tr>
    <td>${w.num}</td>
    <td>${fmtTime(w.startTime)}</td>
    <td><span class="${cls}">${w.direction}</span></td>
    <td>${w.durS.toFixed(0)}s</td>
    <td${bDist}>${w.distM.toFixed(0)} m</td>
    <td${bSpd}>${w.maxSpdKmh.toFixed(1)} km/h</td>
    <td>${w.avgSpdKmh.toFixed(1)} km/h</td>
  </tr>\n`;
});

const html=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Surf Session – ${dateStr}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a1628;color:#e0e8f0;min-height:100vh}
header{padding:20px 28px 16px;border-bottom:1px solid #1e3a5f}
header h1{font-size:1.4rem;color:#7dd3fc;font-weight:700;letter-spacing:-.01em}
header p{font-size:.82rem;color:#64748b;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:18px 28px}
.card{background:#0f2340;border:1px solid #1e3a5f;border-radius:12px;padding:16px 20px}
.card .lbl{font-size:.68rem;color:#7dd3fc;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.card .val{font-size:1.9rem;font-weight:800;color:#f0f8ff;line-height:1.1}
.card .val span{font-size:1rem;font-weight:400;color:#94a3b8}
.card .sub{font-size:.75rem;color:#64748b;margin-top:5px}
.split{display:flex;gap:28px;padding:0 28px 18px}
.split .mini{background:#0f2340;border:1px solid #1e3a5f;border-radius:12px;padding:14px 18px;flex:1}
.mini .lbl{font-size:.68rem;color:#7dd3fc;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.mini .val{font-size:1.3rem;font-weight:700;color:#f0f8ff}
#map{height:500px;margin:0 28px 20px;border-radius:14px;border:1px solid #1e3a5f;overflow:hidden}
.sec-title{padding:0 28px 12px;font-size:.82rem;color:#7dd3fc;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.legend{display:flex;gap:24px;padding:0 28px 14px;font-size:.78rem;color:#94a3b8}
.leg{display:flex;align-items:center;gap:7px}
.dot{width:11px;height:11px;border-radius:50%;flex-shrink:0}
table{width:calc(100% - 56px);margin:0 28px 32px;border-collapse:collapse;font-size:.82rem}
th{background:#0f2340;color:#7dd3fc;padding:10px 14px;text-align:left;border-bottom:2px solid #1e3a5f;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
td{padding:9px 14px;border-bottom:1px solid #111f36;color:#c8d8e8}
tr:nth-child(even) td{background:#0c1e38}
.right{color:#34d399;font-weight:700}
.left{color:#f472b6;font-weight:700}
.straight{color:#fbbf24;font-weight:700}
.best{color:#fbbf24;font-weight:700}
</style>
</head>
<body>
<header>
  <h1>Morning Surf — ${dateStr}</h1>
  <p>${locStr} &nbsp;·&nbsp; Session start ${fmtTime(sessionStart)} PDT</p>
</header>
<div class="cards">
  <div class="card">
    <div class="lbl">Total Waves</div>
    <div class="val">${nWaves}</div>
    <div class="sub">Rights: ${nRights} &nbsp;·&nbsp; Lefts: ${nLefts}</div>
  </div>
  <div class="card">
    <div class="lbl">Session Duration</div>
    <div class="val">${durStr} <span>min:sec</span></div>
    <div class="sub">&nbsp;</div>
  </div>
  <div class="card">
    <div class="lbl">Longest Wave</div>
    <div class="val">${longest.distM.toFixed(0)} <span>m</span></div>
    <div class="sub">Wave #${longest.num} &nbsp;·&nbsp; ${longest.durS.toFixed(0)}s &nbsp;·&nbsp; ${longest.direction}</div>
  </div>
  <div class="card">
    <div class="lbl">Top Speed</div>
    <div class="val">${fastest.maxSpdKmh.toFixed(1)} <span>km/h</span></div>
    <div class="sub">Wave #${fastest.num} &nbsp;·&nbsp; ${fastest.direction}</div>
  </div>
</div>
<div id="map"></div>
<div class="legend">
  <div class="leg"><div class="dot" style="background:#34d399"></div>Right</div>
  <div class="leg"><div class="dot" style="background:#f472b6"></div>Left</div>
  <div class="leg"><div class="dot" style="background:#fbbf24"></div>Straight</div>
  <div class="leg"><div class="dot" style="background:#1e3a5f;border:1px solid #334155"></div>Paddle / wait</div>
</div>
<div class="sec-title">Wave-by-Wave Breakdown</div>
<table>
<thead><tr>
  <th>#</th><th>Time (PDT)</th><th>Direction</th>
  <th>Duration</th><th>Distance</th><th>Top Speed</th><th>Avg Speed</th>
</tr></thead>
<tbody>${tableRows}</tbody>
</table>
<script>
const map=L.map('map').setView([${centreLat},${centreLon}],17);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
L.polyline(${JSON.stringify(fullTrack)},{color:'#1e3a5f',weight:1.5,opacity:0.6}).addTo(map);

const COL={Right:'#34d399',Left:'#f472b6',Straight:'#fbbf24'};
const waves=${JSON.stringify(waveData)};
waves.forEach(w=>{
  const c=COL[w.dir]||'#94a3b8';
  L.polyline(w.track,{color:c,weight:5,opacity:.92}).addTo(map)
   .bindPopup('<b>Wave '+w.num+'</b><br>'+w.dir+' · '+w.distM+'m · '+w.durS+'s<br>Top: '+w.maxKmh+' km/h  Avg: '+w.avgKmh+' km/h');
  L.circleMarker(w.start,{radius:6,fillColor:c,color:'#0a1628',weight:2,fillOpacity:1})
   .addTo(map)
   .bindTooltip('W'+w.num,{permanent:true,direction:'top',className:'wl'});
});
</script>
<style>
.wl{background:transparent!important;border:none!important;box-shadow:none!important;
  color:#f0f8ff;font-size:.66rem;font-weight:800;padding:0;white-space:nowrap}
</style>
</body></html>`;

fs.writeFileSync(OUT_HTML, html, "utf8");
console.log(`\nHTML report: ${OUT_HTML}`);
