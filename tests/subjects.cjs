// Run with Playwright available: SINOPIA_URL=http://localhost:8772 node tests/subjects.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.SINOPIA_URL || 'http://localhost:8772');
    const results = await page.evaluate(() => {
      const S = DrawingCompare.Subjects, A = DrawingCompare.Aligner;
      function round(w, h, cx, cy, rx, ry, rectangle = false) {
        const source = document.createElement('canvas'); source.width = w; source.height = h;
        const c = source.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, w, h); c.strokeStyle = '#222'; c.lineWidth = 3;
        c.beginPath(); if (rectangle) c.rect(cx - rx, cy - ry, rx * 2, ry * 2); else c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); c.stroke();
        return S.roundObjects(A.rasterize({ source, rotation: 0, flipH: false, flipV: false }, 160));
      }
      const circles = [round(400, 400, 150, 230, 70, 70), round(600, 500, 340, 240, 105, 105)];
      const ellipses = [round(400, 400, 160, 210, 80, 60), round(600, 500, 330, 240, 120, 90)];
      const boxes = round(400, 400, 200, 200, 90, 90, true);
      const circleMatch = S.fitRound({ round: circles[0] }, { round: circles[1] });
      const ellipseMatch = S.fitRound({ round: ellipses[0] }, { round: ellipses[1] });
      const ambiguous = S.fitRound({ round: [circles[0][0], circles[0][0]] }, { round: circles[1] });
      const mismatched = S.fitRound({ round: circles[0] }, { round: ellipses[1] });
      function shape(kind, filled, moved) {
        const source=document.createElement('canvas');source.width=moved?600:400;source.height=moved?500:400;
        const c=source.getContext('2d');c.fillStyle='white';c.fillRect(0,0,source.width,source.height);c.strokeStyle='#222';c.fillStyle='#555';c.lineWidth=3;
        if(moved){c.translate(350,220);c.rotate(.15);c.scale(1.2,1.2);c.translate(-200,-200);}
        c.beginPath();
        if(kind==='box')c.rect(130,100,140,200);
        else {c.moveTo(180,70);c.lineTo(220,70);c.lineTo(220,140);c.lineTo(260,180);c.lineTo(260,310);c.lineTo(140,310);c.lineTo(140,180);c.lineTo(180,140);c.closePath();}
        if(filled)c.fill();else c.stroke();
        return S.silhouettes(A.rasterize({source,rotation:0,flipH:false,flipV:false},160));
      }
      const bottle=shape('bottle',false,false), filledBottle=shape('bottle',true,true), box=shape('box',false,false), filledBox=shape('box',true,true);
      // Rotation is opt-in: the third argument is the largest rotation allowed, in radians (default 0).
      const cap = .3;
      const bottleMatch=S.fitSilhouette({silhouettes:bottle},{silhouettes:filledBottle},cap);
      const boxMatch=S.fitSilhouette({silhouettes:box},{silhouettes:filledBox},cap);
      const bottleNoRotation=S.fitSilhouette({silhouettes:bottle},{silhouettes:filledBottle});
      const wrongShape=S.fitSilhouette({silhouettes:bottle},{silhouettes:filledBox});
      const points = Array.from({ length: 68 }, (_, i) => ({ x: 200 + Math.cos(i * .7) * 70, y: 200 + Math.sin(i * .7) * 100 }));
      const put = (indices, x, y) => indices.forEach(i => points[i] = { x, y });
      put([36,37,38,39,40,41], 165,160); put([42,43,44,45,46,47], 235,160);
      put([30],200,205); put([48,54],200,245); put([8],200,300); put([0],120,210); put([16],280,210);
      put([17,18,19,20,21],165,135); put([22,23,24,25,26],235,135);
      const s = .7, theta = .18, tx = 70, ty = 25, transform = p => ({ x: s * (Math.cos(theta) * p.x - Math.sin(theta) * p.y) + tx, y: s * (Math.sin(theta) * p.x + Math.cos(theta) * p.y) + ty });
      const target = points.map(transform);
      const face = { score: .9, box: { x: 100, y: 110, w: 200, h: 210 }, points };
      const fixed = { score: .9, box: { x: 100, y: 100, w: 140, h: 147 }, points: target };
      const view = { width: 400, height: 400 };
      const faceMatch = S.fitFace(face, fixed, view, view, .35);
      const faceNoRotation = S.fitFace(face, fixed, view, view); // default: scale and translation only
      const faceCapped = S.fitFace(face, fixed, view, view, .1); // true tilt .18 is beyond a .1 cap
      const badMouth = { ...face, points: points.map((p, i) => [48,54].includes(i) ? { x: p.x + 65, y: p.y } : p) };
      const outlierMatch = S.fitFace(badMouth, fixed, view, view, .35);
      // Mapping a detection back into source space must undo turns AND flips.
      const mapped = S.toSource({ x: 40, y: 30 }, { source: { width: 100, height: 60 }, rotation: 90, flipH: true, flipV: false }, 60, 100);
      return { bottleNoRotation, faceNoRotation, faceCapped, bottleMatch, boxMatch, wrongShape, circles, ellipses, boxes, circleMatch, ellipseMatch, ambiguous, mismatched, faceMatch, outlierMatch, expected: { s, theta, tx: tx + s * (Math.cos(theta) * 200 - Math.sin(theta) * 200) - 200, ty: ty + s * (Math.sin(theta) * 200 + Math.cos(theta) * 200) - 200 }, mapped };
    });
    for(const match of [results.bottleMatch,results.boxMatch]){assert(match,JSON.stringify(results));assert(Math.abs(match.s-1.2)<.05);assert(Math.abs(match.theta-.15)<.04);assert(Math.abs(match.tx-50)<5);assert(Math.abs(match.ty+30)<5);}
    assert.equal(results.wrongShape,null);
    // No tilt by default: a rotated silhouette is declined, a face fit has theta exactly 0 and is never confident for a tilted target, a cap is never exceeded.
    assert.equal(results.bottleNoRotation,null);
    assert(results.faceNoRotation && results.faceNoRotation.theta === 0, JSON.stringify(results.faceNoRotation));
    assert(!results.faceCapped || Math.abs(results.faceCapped.theta) <= .1 + 1e-9, JSON.stringify(results.faceCapped));
    assert(results.circles.every(a => a.length === 1), JSON.stringify(results.circles));
    assert(results.ellipses.every(a => a.length === 1), JSON.stringify(results.ellipses));
    assert.equal(results.boxes.length, 0); assert.equal(results.ambiguous, null); assert.equal(results.mismatched, null);
    assert(Math.abs(results.circleMatch.s - 1.5) < .05); assert(Math.abs(results.circleMatch.tx - 115) < 4); assert(Math.abs(results.circleMatch.ty + 55) < 4);
    assert(Math.abs(results.ellipseMatch.s - 1.5) < .05);
    for (const match of [results.faceMatch, results.outlierMatch]) {
      assert(match, JSON.stringify(results));
      for (const key of ['s','theta','tx','ty']) assert(Math.abs(match[key] - results.expected[key]) < 1e-6, `${key}: ${match[key]}`);
    }
    assert.equal(results.outlierMatch.approximate, true); assert.deepEqual(results.mapped, { x: 30, y: 40 });
    assert.deepEqual(errors, []); console.log('Passed circles, ellipses, box/bottle silhouette fits, unrelated-shape rejection, ambiguity, proportions, robust facial fit and orientation mapping.');
  } finally { await browser.close(); }
})();
