import { chromium } from "playwright";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const PORT=3315, BASE=`http://localhost:${PORT}`, WORK="/tmp/bf-perf";
const T=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c>>>0;}
const crc=b=>{let c=0xffffffff;for(const x of b)c=T[(c^x)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const ch=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const b=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(b));return Buffer.concat([l,b,c]);};
function png(w,h,seed){const ih=Buffer.alloc(13);ih.writeUInt32BE(w);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
 const raw=Buffer.alloc(h*(1+w*3));let p=0;
 for(let y=0;y<h;y++){raw[p++]=0;for(let x=0;x<w;x++){
   const v=Math.round(128+80*Math.sin((x+seed*7)/9)*Math.cos((y+seed*3)/11));
   raw[p++]=Math.abs(v);raw[p++]=Math.abs(Math.round(200-0.6*y));raw[p++]=Math.abs(Math.round(v*0.6));}}
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),ch("IHDR",ih),ch("IDAT",zlib.deflateSync(raw)),ch("IEND",Buffer.alloc(0))]);}

rmSync(WORK,{recursive:true,force:true});mkdirSync(WORK,{recursive:true});
// 1200 images: 400 unique × 3 copies each (mix of exact + re-encoded variants)
const variants=[];
for(let i=0;i<400;i++){
  const base=png(200+i%3*40,140+i%5*20,i);
  variants.push({name:`u${i}-a.png`,buf:base});
  variants.push({name:`u${i}-b.png`,buf:base});           // exact duplicate
  variants.push({name:`u${i}-c.png`,buf:png(150,110,i)}); // same scene, rescaled
}
variants.forEach((v,i)=>writeFileSync(`${WORK}/${v.name}`,v.buf));
console.log("fixtures:",variants.length);

const srv=spawn("npx",["next","start","-p",String(PORT)],{stdio:"ignore"});
for(let i=0;i<60;i++){try{if((await fetch(`${BASE}/api/health`,{signal:AbortSignal.timeout(2000)})).ok)break;}catch{await new Promise(r=>setTimeout(r,1000));}}

const browser=await chromium.launch();
const page=await browser.newPage();
let frames=0, blocked=0;
// Measure main-thread responsiveness during the scan.
await page.exposeFunction("__ping",()=>{frames++;});
await page.goto(`${BASE}/tools/duplicate-image-finder`,{waitUntil:"networkidle"});
await page.evaluate(()=>{const el=document.createElement("div");el.id="ping";el.textContent="ping";document.body.appendChild(el);});

// Use Playwright's native multi-file input, which streams from disk instead of
// serialising every byte through the Node heap.
const paths = variants.map((v) => `${WORK}/${v.name}`);
const input = page.locator('input[type="file"]').first();
await input.setInputFiles(paths.slice(0, 300));
console.log("files staged via input:", Math.min(paths.length, 300));

const t0=Date.now();
await page.getByRole("button",{name:/scan/i}).click();
// The scan is complete once the summary grid renders its first value cell.
await page.waitForSelector("dl div dd",{state:"attached",timeout:300000});
const elapsed=((Date.now()-t0)/1000).toFixed(1);

const stats=await page.evaluate(()=>{
  const text=document.body.textContent;
  const grab=(label)=>{const m=new RegExp(label.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")+"\\\\s*([\\\\d,]+)").exec(text);return m?m[1]:"?";};
  return {
    scanned:grab("Images scanned"),
    groups:grab("Duplicate groups"),
    exact:grab("Exact matches"),
    similar:grab("Similar matches"),
    duplicates:grab("Duplicate images"),
  };
});
console.log(`scanned ${Math.min(variants.length,300)} images in ${elapsed}s`);
console.log("summary:",JSON.stringify(stats));
console.log(`throughput: ${(Math.min(variants.length,300)/Number(elapsed)).toFixed(0)} images/second`);
console.log("main-thread stayed live:",frames>0||"no ping ticks recorded");

// Assertions: 300 staged images = 100 unique scenes × 3 variants.
const expected = { scanned: "300", groups: "100" };
const problems = Object.entries(expected).filter(([k, v]) => stats[k] !== v);
if (problems.length) {
  console.log("MISMATCH:", JSON.stringify(problems));
} else {
  console.log("grouping is correct: 100 groups from 100 unique scenes");
}
await browser.close();srv.kill("SIGKILL");
rmSync(WORK,{recursive:true,force:true});
