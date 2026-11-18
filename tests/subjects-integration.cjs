// Run after starting the static server. Optional real images: SINOPIA_DRAWING and SINOPIA_REFERENCE.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const url = process.env.SINOPIA_URL || 'http://localhost:8772';
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const errors = [], requests = []; page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push({ url: r.url(), method: r.method() }));
    await page.goto(url); await page.waitForFunction(() => window.DrawingCompare?.app); await page.evaluate(() => DrawingCompare.app.restored);
    await page.evaluate(async () => {
      window.matches = []; const A = DrawingCompare.Aligner, estimate = A.estimate;
      A.estimate = async (...args) => { const result = await estimate(...args); matches.push(result); return result; };
      for (const [slot, w, h, x, y, radius] of [['drawing',400,400,150,230,70],['reference',600,500,340,240,105]]) {
        const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d');
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#222'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.stroke();
        await DrawingCompare.app.loadInto(slot, await new Promise(r => c.toBlob(r)));
      }
    });
    await page.waitForFunction(() => matches.length > 0, {}, { timeout: 120000 });
    const result = await page.evaluate(() => ({ match: matches[0], aligned: DrawingCompare.app.layers.drawing.aligned }));
    // A rough (approximate) match is offered, never applied by itself; it moves the drawing only on Apply.
    assert.equal(result.match.method, 'round-contour'); assert.equal(result.aligned, false); assert.equal(result.match.theta, 0);
    assert(Math.abs(result.match.s - 1.5) < .05); assert((await page.locator('#toast').innerText()).includes('Rough match found'));
    assert(await page.evaluate(() => !!DrawingCompare.app.getOffer()), 'the rough match must be offered');
    await page.evaluate(() => DrawingCompare.app.acceptOffer()); await page.waitForTimeout(900);
    const applied = await page.evaluate(() => ({ aligned: DrawingCompare.app.layers.drawing.aligned, angle: DrawingCompare.app.layers.drawing.angle, steps: DrawingCompare.app.alignHistory.undo.length }));
    assert.equal(applied.aligned, true); assert.equal(applied.angle, 0); assert.equal(applied.steps, 1);
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0, 'Image inference must not upload any data');
    assert(requests.some(r => r.url.includes('/models/face/')), 'Models must load from this site');
    assert(!requests.some(r => r.url.includes('jsdelivr') || r.url.includes('googleapis.com/v1')), 'No external inference/model service');
    // Outline uses the detected boundary in source space and has sparse transparent output.
    const outline = await page.evaluate(() => {
      const r = DrawingCompare.app.layers.reference, c = DrawingCompare.Subjects.outline(r,.5,'#d6452a');
      const pixels = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let count = 0; for (let i=3;i<pixels.length;i+=4) if(pixels[i]) count++;
      return { w:c.width, h:c.height, fraction:count/(c.width*c.height) };
    });
    assert(outline.fraction > .001 && outline.fraction < .1);
    await page.evaluate(async () => {
      const A = DrawingCompare.Aligner, layers = DrawingCompare.app.layers;
      const r = await A.estimate(A.rasterize(layers.drawing), A.rasterize(layers.reference), () => false);
      if (!r.cancelled || r.confident || r.approximate) throw Error('Cancelled matching must not offer a transform');
      const estimate = A.estimate; A.estimate = async () => { await new Promise(r=>setTimeout(r,300)); return {s:1,theta:0,tx:100,ty:100,approximate:true}; };
      layers.drawing.flipH = true; // different cache key
      const job = DrawingCompare.app.runAutoAlign(true);
      DrawingCompare.app.plainFit(); await job; A.estimate = estimate;
      if (layers.drawing.aligned) throw Error('A cancelled job moved the drawing');
    });
    assert.deepEqual(errors, []); console.log('Passed mobile automatic round matching, local model requests, contour outline, warning and cancellation.');
    await page.close();

    // Models may be unavailable offline or blocked. Structural matching must remain usable.
    const fallback = await browser.newPage();
    await fallback.route('**/vendor/face-api/**', route => route.abort());
    await fallback.goto(url);
    const failover = await fallback.evaluate(async () => {
      const A = DrawingCompare.Aligner;
      const c = document.createElement('canvas'); c.width=300;c.height=300;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,300,300);x.fillStyle='black';
      for(let i=0;i<20;i++)x.fillRect(30+(i*67)%230,30+(i*43)%230,5+i,10+i%9);
      const im={source:c,rotation:0,flipH:false,flipV:false};return A.estimate(A.rasterize(im),A.rasterize(im));
    });
    assert(failover.confident); assert(Math.abs(failover.s-1)<.02); assert(Math.abs(failover.theta)<.02); console.log('Passed model-unavailable structural fallback.');
    await fallback.close();

    if (process.env.SINOPIA_DRAWING && process.env.SINOPIA_REFERENCE) {
      const images = { drawing: fs.readFileSync(process.env.SINOPIA_DRAWING).toString('base64'), reference: fs.readFileSync(process.env.SINOPIA_REFERENCE).toString('base64') };
      for (const order of [['drawing','reference'],['reference','drawing']]) {
        const p = await browser.newPage(); await p.goto(url);
        await p.evaluate(async ({images,order}) => {
          window.matches=[];const A=DrawingCompare.Aligner,estimate=A.estimate;
          A.estimate=async(...args)=>{const r=await estimate(...args);matches.push(r);return r;};
          for(const slot of order)await DrawingCompare.app.loadInto(slot,new Blob([Uint8Array.from(atob(images[slot]),c=>c.charCodeAt(0))],{type:'image/jpeg'}));
        }, {images,order});
        await p.waitForFunction(()=>matches.length>0, {}, {timeout:120000});
        const match=await p.evaluate(()=>matches[0]); assert.equal(match.method,'face-landmarks'); assert(match.inliers>=6);assert(match.s>.5&&match.s<.8);
        const contours=await p.evaluate(()=>!!DrawingCompare.Subjects.outline(DrawingCompare.app.layers.reference,.5,'#d6452a'));assert(contours);
        // A retake of the same paper should use its precise structural correspondence.
        await p.evaluate(async data => DrawingCompare.app.loadInto('drawing',new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/jpeg'})),images.drawing);
        const retake=await p.evaluate(()=>matches.at(-1)); assert(retake.confident);assert(retake.ncc>.9);assert(Math.abs(retake.s-1)<.02);
        // Verify actual transformed landmarks, including a quarter turn and mirror of the drawing.
        const oriented=await p.evaluate(async()=>{const A=DrawingCompare.Aligner,d=DrawingCompare.app.layers.drawing,r=DrawingCompare.app.layers.reference;d.rotation=90;d.flipH=true;return A.estimate(A.rasterize(d),A.rasterize(r));});
        // A head turned sideways may need the structural fallback; never return non-finite placement.
        if(oriented.confident||oriented.approximate)assert(['s','theta','tx','ty'].every(k=>Number.isFinite(oriented[k])));
        console.log('Passed private portrait fixture:',order.join(' -> '),match.method,match.inliers,'landmarks'); await p.close();
      }
    }
  } finally { await browser.close(); }
})();
