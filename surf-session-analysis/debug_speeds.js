#!/usr/bin/env node
"use strict";
const fs = require("fs");
const GPX_FILE = "/Users/chi-hoongkok/Documents/Anthropic/surf/20260328_Morning_Surf.gpx";

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

const xml = fs.readFileSync(GPX_FILE,"utf8");
const re  = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>[\s\S]*?<time>([^<]+)<\/time>/g;
const pts = []; let m;
while((m=re.exec(xml))!==null)
  pts.push({lat:parseFloat(m[1]),lon:parseFloat(m[2]),ts:new Date(m[3])});

console.log(`Points: ${pts.length}`);

// compute speeds
for(let i=0;i<pts.length;i++){
  if(i===0){pts[i].spd=0;pts[i].brg=0;continue;}
  const dt=(pts[i].ts-pts[i-1].ts)/1000;
  if(dt<=0){pts[i].spd=pts[i-1].spd;pts[i].brg=pts[i-1].brg;continue;}
  pts[i].spd=haversine(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon)/dt;
  pts[i].brg=bearing(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon);
}
const sm=smooth(pts.map(p=>p.spd),5);
pts.forEach((p,i)=>p.spdS=sm[i]);

// speed histogram (km/h buckets)
const kmh=pts.map(p=>p.spdS*3.6);
const buckets=new Array(30).fill(0);
kmh.forEach(v=>{const b=Math.min(29,Math.floor(v/2));buckets[b]++;});
console.log("\nSpeed distribution (km/h, smoothed):");
buckets.forEach((c,i)=>{
  if(c>0) console.log(`  ${(i*2).toString().padStart(2)}-${(i*2+2).toString().padStart(2)} km/h: ${c.toString().padStart(5)}  ${"#".repeat(Math.min(60,Math.round(c/5)))}`);
});

// show top-speed moments
console.log("\nTop 30 speed moments:");
const sorted=[...pts].sort((a,b)=>b.spdS-a.spdS).slice(0,30);
sorted.forEach(p=>{
  const t=p.ts.toISOString().slice(11,19);
  console.log(`  ${t}  ${(p.spdS*3.6).toFixed(1).padStart(6)} km/h  brg=${p.brg.toFixed(0).padStart(3)}°  lat=${p.lat.toFixed(6)} lon=${p.lon.toFixed(6)}`);
});

// show speed timeline – sample every 30s and show anything > 5 km/h
console.log("\nSpeed timeline (entries > 4 km/h):");
let lastT=0;
pts.forEach(p=>{
  const t=p.ts.getTime()/1000;
  if(p.spdS*3.6>4 && t-lastT>2){
    console.log(`  ${p.ts.toISOString().slice(11,19)}  ${(p.spdS*3.6).toFixed(1).padStart(6)} km/h  brg=${p.brg.toFixed(0).padStart(3)}°`);
    lastT=t;
  }
});

// Show lat/lon range
const lats=pts.map(p=>p.lat), lons=pts.map(p=>p.lon);
console.log(`\nLat range: ${Math.min(...lats).toFixed(6)} – ${Math.max(...lats).toFixed(6)}`);
console.log(`Lon range: ${Math.min(...lons).toFixed(6)} – ${Math.max(...lons).toFixed(6)}`);
console.log(`Lat spread: ${((Math.max(...lats)-Math.min(...lats))*111000).toFixed(0)} m`);
console.log(`Lon spread: ${((Math.max(...lons)-Math.min(...lons))*111000*Math.cos(lats[0]*Math.PI/180)).toFixed(0)} m`);
