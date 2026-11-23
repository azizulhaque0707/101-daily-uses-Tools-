import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
const PORT = 3518;
const WORK = "/tmp/bf-appdbg";
rmSync(WORK,{recursive:true,force:true}); mkdirSync(WORK,{recursive:true});
const server = spawn("npx",["next","start","-p",String(PORT)],{stdio:"ignore"});
for(let i=0;i<60;i++){try{if((await fetch(`http://localhost:${PORT}/api/health`,{signal:AbortSignal.timeout(2000)})).ok)break;}catch{await new Promise(r=>setTimeout(r,1000));}}
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", m => { const t=m.text(); if(/error|Error|fail/i.test(t)) console.log("[console]", t.slice(0,400)); });
page.on("pageerror", e => console.log("[pageerror]", e.message.slice(0,300)));
await page.goto(`http://localhost:${PORT}/`,{waitUntil:"domcontentloaded"});
const video = await page.evaluate(async () => {
  const c=document.createElement("canvas");c.width=320;c.height=240;const ctx=c.getContext("2d");
  const s=c.captureStream(15); const ac=new AudioContext(); const o=ac.createOscillator(); const g=ac.createGain();
  g.gain.value=0.15; const d=ac.createMediaStreamDestination(); o.connect(g).connect(d); o.start();
  s.addTrack(d.stream.getAudioTracks()[0]);
  const mime=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(t=>MediaRecorder.isTypeSupported(t));
  const rec=new MediaRecorder(s,{mimeType:mime}); const ch=[]; rec.ondataavailable=e=>e.data.size>0&&ch.push(e.data);
  const done=new Promise(r=>rec.onstop=r); rec.start(200); const t0=performance.now();
  for(;;){const e=(performance.now()-t0)/1000; if(e>=2)break; ctx.fillStyle=`hsl(${(e*90)%360},80%,60%)`; ctx.fillRect(0,0,320,240);
    await new Promise(r=>setTimeout(r,1000/15));}
  rec.stop(); await done; o.stop(); ac.close();
  return Array.from(new Uint8Array(await new Blob(ch,{type:mime}).arrayBuffer()));
});
writeFileSync(`${WORK}/clip.webm`, Buffer.from(video));

// Run the video-compressor tool through the real UI and capture everything.
await page.goto(`http://localhost:${PORT}/tools/video-compressor`, { waitUntil: "networkidle" });
const input = page.locator('input[type="file"]').first();
await input.setInputFiles([`${WORK}/clip.webm`]);
await page.getByRole("button", { name: /run tool/i }).click();
await page.waitForTimeout(45000);
const state = await page.evaluate(() => {
  const alert = document.querySelector('[role="alert"]');
  const result = [...document.querySelectorAll('[aria-live="polite"]')].map(e=>e.textContent).join(" | ");
  return { alert: alert ? alert.textContent : null, result: result.slice(0,400) };
});
console.log("ALERT:", state.alert);
console.log("RESULT:", state.result);
await browser.close(); server.kill("SIGKILL");
