// Phase 3 canvas marks for Body, Hands, and Outline (reuses DC.PropUI's coordinate transforms and tokens).
// Pure canvas drawing helpers attached to window.DrawingCompare.PropMarksP3.
(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});
  const INK = '#2a2521', SINOPIA = '#a5502f', VERMILION = '#c2492a', HALO = '#fbf7ee', SQUASH = '#2f6f86', PAPER = '#f4efe5';
  const SERIF = '"Fraunces", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---- shared primitives
  function halo(ctx, fn, w, col = HALO, alpha = 0.88) {
    ctx.save(); ctx.globalAlpha *= alpha; ctx.lineWidth = w; ctx.strokeStyle = col;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; fn(); ctx.restore();
  }
  function ring(ctx, x, y, r, col, w) {
    const p = () => { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); };
    halo(ctx, () => { p(); ctx.stroke(); }, w + 2.4);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; p(); ctx.stroke(); ctx.restore();
  }
  function dot(ctx, x, y, r, col) {
    ctx.save(); ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill(); ctx.restore();
  }
  function line(ctx, pts, col, w, dash, hal = true) {
    if (pts.length < 2) return;
    const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
    if (hal) halo(ctx, () => { ctx.setLineDash([]); path(); ctx.stroke(); }, w + 2.0, HALO, 0.7);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; path(); ctx.stroke(); ctx.restore();
  }
  function arrow(ctx, a, b, col, w) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1.2) return;
    const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = Math.min(9, Math.max(4, len * 0.45)), hw = 0.5;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.moveTo(b.x - hl * Math.cos(ang - hw), b.y - hl * Math.sin(ang - hw)); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - hl * Math.cos(ang + hw), b.y - hl * Math.sin(ang + hw));
    };
    halo(ctx, () => { path(); ctx.stroke(); }, w + 2.4);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; path(); ctx.stroke(); ctx.restore();
  }
  function chip(ctx, text, x, y, opt = {}) {
    ctx.save();
    ctx.font = `${opt.italic === false ? '' : 'italic '}${opt.bold ? '600 ' : '500 '}${opt.size || 12}px ${SERIF}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 12, hh = (opt.size || 12) + 8;
    const W = opt.W || 1e9, Hh = opt.H || 1e9;
    const cx = opt.left ? x + w / 2 : clamp(x, w / 2 + 4, W - w / 2 - 4), cy = clamp(y, hh / 2 + 4, Hh - hh / 2 - 4);
    ctx.fillStyle = opt.fill || PAPER; ctx.strokeStyle = opt.stroke || SINOPIA; ctx.lineWidth = 1;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(cx - w / 2, cy - hh / 2, w, hh, 3); else ctx.rect(cx - w / 2, cy - hh / 2, w, hh); ctx.fill(); ctx.stroke();
    ctx.fillStyle = opt.color || SINOPIA; ctx.fillText(text, cx, cy + 0.5);
    ctx.restore();
    return { x: cx - w / 2, y: cy - hh / 2, w, h: hh };
  }
  function tagMark(ctx, x, y, n, major, on) {
    const r = on ? 11.5 : 10;
    ctx.save();
    ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(x, y, r + 1.8, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    if (major) { ctx.fillStyle = VERMILION; ctx.fill(); } else { ctx.fillStyle = PAPER; ctx.fill(); ctx.strokeStyle = SINOPIA; ctx.lineWidth = 1.8; ctx.stroke(); }
    ctx.fillStyle = major ? '#fff' : SINOPIA; ctx.font = `700 ${n > 9 ? 10 : 11.5}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), x, y + 0.5);
    ctx.restore();
  }
  function pinMark(ctx, x, y) {
    const R = 13;
    ctx.save();
    halo(ctx, () => { ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - R - 4, y); ctx.lineTo(x - R + 3, y); ctx.moveTo(x + R - 3, y); ctx.lineTo(x + R + 4, y); ctx.moveTo(x, y - R - 4); ctx.lineTo(x, y - R + 3); ctx.moveTo(x, y + R - 3); ctx.lineTo(x, y + R + 4); ctx.stroke(); }, 4.2);
    ctx.strokeStyle = VERMILION; ctx.lineWidth = 1.5; ctx.setLineDash([3.2, 3]); ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x - R - 4, y); ctx.lineTo(x - R + 3, y); ctx.moveTo(x + R - 3, y); ctx.lineTo(x + R + 4, y); ctx.moveTo(x, y - R - 4); ctx.lineTo(x, y - R + 3); ctx.moveTo(x, y + R - 3); ctx.lineTo(x, y + R + 4); ctx.stroke();
    ctx.restore();
    dot(ctx, x, y, 3.4, VERMILION);
  }
  function squareHandle(ctx, x, y, col) {
    ctx.save(); ctx.fillStyle = HALO; ctx.strokeStyle = col; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.rect(x - 4.5, y - 4.5, 9, 9); ctx.fill(); ctx.stroke(); ctx.restore();
  }

  // ---- Hatching pattern cache for Outline band
  const hatchCache = {};
  function hatchPattern(ctx, color, angleDeg) {
    const k = color + '|' + angleDeg;
    if (hatchCache[k]) return hatchCache[k];
    const c = document.createElement('canvas'); c.width = 10; c.height = 10;
    const x = c.getContext('2d');
    x.strokeStyle = color; x.lineWidth = 1.25; x.globalAlpha = 0.55;
    x.beginPath();
    if (angleDeg > 0) { x.moveTo(-2, 10); x.lineTo(10, -2); x.moveTo(0, 12); x.lineTo(12, 0); }
    else { x.moveTo(-2, 0); x.lineTo(10, 12); x.moveTo(0, -2); x.lineTo(12, 10); }
    x.stroke();
    return (hatchCache[k] = ctx.createPattern(c, 'repeat'));
  }

  // ---- Rotated bracket (used for both Body limbs and Hand fingers)
  function drawSpanBracket(ctx, D1, D2, R1, R2, text, severity, W, H, off = 26) {
    const u = { x: D2.x - D1.x, y: D2.y - D1.y }, Ld = Math.hypot(u.x, u.y) || 1;
    u.x /= Ld; u.y /= Ld;
    const Lr = Math.hypot(R2.x - R1.x, R2.y - R1.y);
    let nrm = { x: -u.y, y: u.x };
    if (nrm.x < 0 && Math.abs(u.y) > Math.abs(u.x)) nrm = { x: -nrm.x, y: -nrm.y };
    const sh = (p, k) => ({ x: p.x + nrm.x * k, y: p.y + nrm.y * k });
    const ru = { x: R2.x - R1.x, y: R2.y - R1.y }, rl = Math.hypot(ru.x, ru.y) || 1;
    ru.x /= rl; ru.y /= rl;
    const rs = sh(R1, off), re = { x: rs.x + ru.x * Lr, y: rs.y + ru.y * Lr };
    const ds = sh(D1, off + 9), de = { x: ds.x + u.x * Ld, y: ds.y + u.y * Ld };
    line(ctx, [sh(R1, 4), rs], SINOPIA, 1, [2, 2]); line(ctx, [sh(R2, 4), re], SINOPIA, 1, [2, 2]);
    line(ctx, [rs, re], SINOPIA, 1.6, [5, 4]);
    line(ctx, [sh(D1, 4), ds], INK, 1, [2, 2]); line(ctx, [sh(D2, 4), de], INK, 1, [2, 2]);
    line(ctx, [ds, de], INK, 1.8);
    for (const p of [rs, re, ds, de]) {
      line(ctx, [{ x: p.x - nrm.y * 4, y: p.y + nrm.x * 4 }, { x: p.x + nrm.y * 4, y: p.y - nrm.x * 4 }], p === rs || p === re ? SINOPIA : INK, 1.4, null, true);
    }
    const extra = Math.abs(Ld - Lr);
    if (extra > 1.5) {
      if (Ld > Lr) line(ctx, [{ x: ds.x + u.x * Lr, y: ds.y + u.y * Lr }, de], VERMILION, 4.2);
      else line(ctx, [{ x: rs.x + ru.x * Ld, y: rs.y + ru.y * Ld }, re], VERMILION, 4.2);
    }
    const mid = { x: (ds.x + de.x) / 2, y: (ds.y + de.y) / 2 };
    chip(ctx, text, mid.x + nrm.x * 16, mid.y + nrm.y * 16, { W, H, size: 11.5, bold: true, fill: severity === 'major' ? VERMILION : PAPER, color: severity === 'major' ? '#fff' : SINOPIA, stroke: severity === 'major' ? VERMILION : SINOPIA, italic: false });
  }

  // ---- Angle arc between two segments
  function drawAngleMark(ctx, A1, A2, B1, B2, label, major, W, H) {
    const a1 = Math.atan2(A2.y - A1.y, A2.x - A1.x), a2 = Math.atan2(B2.y - B1.y, B2.x - B1.x);
    line(ctx, [B1, B2], SINOPIA, 1.4, [4, 3]);
    line(ctx, [A1, A2], INK, 1.5);
    const r = Math.min(34, Math.max(18, dist(A1, A2) * 0.45));
    let diff = ((a2 - a1 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    ctx.save(); ctx.strokeStyle = major ? VERMILION : SINOPIA; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(A1.x, A1.y, r, a1, a1 + diff, diff < 0); ctx.stroke(); ctx.restore();
    const am = a1 + diff / 2;
    if (label) chip(ctx, label, A1.x + Math.cos(am) * (r + 18), A1.y + Math.sin(am) * (r + 18), { W, H, size: 11, bold: true, fill: PAPER, color: major ? VERMILION : SINOPIA, stroke: major ? VERMILION : SINOPIA, italic: false });
  }

  // ---- Tag repulsion
  function placeTags(ctx, tags, W, H, hits) {
    for (let it = 0; it < 8; it++) for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
      const d = dist(tags[i], tags[j]);
      if (d < 24) {
        const k = (24 - d) / 2 + 0.01, ux = d ? (tags[i].x - tags[j].x) / d : 1, uy = d ? (tags[i].y - tags[j].y) / d : 0;
        tags[i].x += ux * k; tags[i].y += uy * k; tags[j].x -= ux * k; tags[j].y -= uy * k;
      }
    }
    for (const t of tags) {
      t.x = clamp(t.x, 14, W - 14); t.y = clamp(t.y, 14, H - 14);
      ctx.save(); ctx.globalAlpha = t.alpha;
      tagMark(ctx, t.x, t.y, t.r.n, t.r.severity === 'major', t.on);
      ctx.restore();
      hits.push({ kind: 'tag', id: t.r.id, x: t.x, y: t.y, r: 15 });
    }
  }

  // ========================================================================================== OUTLINE BAND
  function drawOutline(ctx, outRep, o) {
    if (!outRep || !outRep.ok || !outRep.contour) return;
    const { rPos, W, H, selRow, rows, hits, calm, tk } = o;
    const samples = outRep.samples || [];
    if (samples.length > 2) {
      // reference contour: thin sinopia line (dotted grey for not-found stretches)
      ctx.save();
      ctx.globalAlpha = calm ? 0.55 : 0.82;
      let run = [], wasFound = null;
      const flush = (found) => {
        if (run.length < 2) { run = []; return; }
        const pts = run.map(s => rPos(s.ref));
        if (found) line(ctx, pts, SINOPIA, 1.3, null, true);
        else line(ctx, pts, '#7f7a74', 1.1, [2, 3], false);
        run = [];
      };
      for (const s of samples) {
        const f = !!s.found;
        if (wasFound !== null && f !== wasFound && run.length) { run.push(s); flush(wasFound); }
        run.push(s); wasFound = f;
      }
      if (run.length) { run.push(samples[0]); flush(wasFound); }
      ctx.restore();
    }

    const regions = outRep.regions || [];
    const rowByReg = new Map();
    for (const r of rows || []) if (r.section === 'outline' && r.region) rowByReg.set(r.region, r);

    for (const rg of regions) {
      const row = rowByReg.get(rg);
      const on = !!(selRow && row && selRow.id === row.id);
      const out = rg.sign > 0;
      const refPts = rg.band.reference.map(rPos), drawPts = rg.band.drawing.map(rPos);
      if (refPts.length < 2) continue;
      ctx.save();
      ctx.globalAlpha = calm && !on ? 0.48 : (selRow && !on ? 0.55 : 0.92);
      ctx.beginPath();
      refPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      for (let i = drawPts.length - 1; i >= 0; i--) ctx.lineTo(drawPts[i].x, drawPts[i].y);
      ctx.closePath();
      ctx.fillStyle = out ? 'rgba(194, 73, 42, 0.24)' : 'rgba(47, 111, 134, 0.24)';
      ctx.fill();
      const pat = hatchPattern(ctx, out ? VERMILION : SQUASH, out ? 45 : -45);
      if (pat) { ctx.fillStyle = pat; ctx.fill(); }
      ctx.restore();

      if (on && rg.peak && rg.peak.ref && rg.peak.match) {
        const a = rPos(rg.peak.ref), b = rPos(rg.peak.match);
        line(ctx, [a, b], out ? VERMILION : SQUASH, 2.0);
        const pct = Math.max(1, Math.round(Math.abs(rg.peak.d)));
        const chipText = tk(out ? 'outline.chip.out' : 'outline.chip.in', { n: pct });
        chip(ctx, chipText, (a.x + b.x) / 2 + (out ? 22 : -22), (a.y + b.y) / 2 - 14, {
          W, H, size: 11.5, bold: true, fill: out ? VERMILION : SQUASH, color: '#fff', stroke: out ? VERMILION : SQUASH, italic: false,
        });
      }
    }

    // Numbered tags at region peaks
    const tags = [];
    for (const rg of regions) {
      const row = rowByReg.get(rg);
      if (!row || !rg.peak || !rg.peak.ref) continue;
      const q = rPos(rg.peak.match || rg.peak.ref);
      const on = !!(selRow && selRow.id === row.id);
      tags.push({ r: row, on, alpha: calm && !on ? 0.65 : (selRow && !on ? 0.5 : 1), x: q.x + 16, y: q.y - 12 });
    }
    if (tags.length) placeTags(ctx, tags, W, H, hits);
  }

  // ========================================================================================== BODY MARKS
  const BODY_BONES = [
    ['headTop', 'chin'], ['chin', 'neck'],
    ['shoulderR', 'neck'], ['neck', 'shoulderL'],
    ['shoulderR', 'elbowR'], ['elbowR', 'wristR'],
    ['shoulderL', 'elbowL'], ['elbowL', 'wristL'],
    ['neck', 'hipC'], ['hipR', 'hipL'],
    ['hipR', 'kneeR'], ['kneeR', 'ankleR'],
    ['hipL', 'kneeL'], ['kneeL', 'ankleL'],
  ];
  const BODY_ORDER = ['headTop', 'chin', 'neck', 'shoulderR', 'shoulderL', 'elbowR', 'elbowL', 'wristR', 'wristL', 'hipR', 'hipL', 'kneeR', 'kneeL', 'ankleR', 'ankleL', 'heelR', 'heelL', 'toeR', 'toeL'];

  function drawBody(ctx, body, o) {
    if (!body || !body.ok) return;
    const { slot, dShow, rShow, dPos, rPos, W, H, ov, hits, hitR, selRow, rows, s, hoverHeads, tk, edited } = o;
    const Dp = body.Dp, Rp = body.Rp, al = body.al;

    // 1) Skeleton
    if (s.skeleton !== false) {
      for (const [show, P_, pos, col, dash, alpha] of [[rShow, Rp, rPos, SINOPIA, [5, 4], 0.55], [dShow, Dp, dPos, INK, null, 0.45]]) {
        if (!show) continue;
        ctx.save(); ctx.globalAlpha = alpha;
        for (const [a, b] of BODY_BONES) {
          if (P_[a] && P_[b]) line(ctx, [pos(P_[a]), pos(P_[b])], col, 1.1, dash, false);
        }
        ctx.restore();
      }
    }

    // 2) Balance line (plumb from reference pit of neck down to foot level)
    if (rShow && Rp.neck && (Rp.ankleR || Rp.ankleL || Rp.hipC)) {
      const nk = rPos(Rp.neck);
      const lowY = Math.max(Rp.ankleR ? rPos(Rp.ankleR).y : 0, Rp.ankleL ? rPos(Rp.ankleL).y : 0, Rp.hipC ? rPos(Rp.hipC).y + 80 : 0);
      if (lowY > nk.y + 20) {
        ctx.save(); ctx.globalAlpha = 0.65;
        line(ctx, [nk, { x: nk.x, y: lowY + 8 }], SINOPIA, 1.1, [4, 4], false);
        ctx.font = `italic 500 11px ${SERIF}`; ctx.fillStyle = SINOPIA; ctx.textAlign = 'center';
        ctx.fillText(tk('balance.line'), nk.x, lowY - 6);
        ctx.restore();
      }
    }

    // 3) Heads ruler (when size === 'head' or hovering "Heads tall")
    if (rShow && (s.size === 'head' || hoverHeads) && Rp.headTop && body.report.unit && body.report.unit.px) {
      const top = rPos(Rp.headTop), unitPx = body.report.unit.px * (rPos({ x: Rp.headTop.x, y: Rp.headTop.y + 100 }).y - top.y) / 100;
      const ht = body.report.info && body.report.info.headsTall;
      const totalH = (ht && ht.reference) ? ht.reference : 7.5;
      const pts = Object.values(Rp).filter(Boolean).map(rPos);
      const minX = pts.length ? Math.min(...pts.map(p => p.x)) : top.x;
      const rx = clamp(minX - 38, 22, W - 40);
      if (unitPx > 8) {
        ctx.save(); ctx.globalAlpha = 0.85;
        const nHeads = Math.ceil(totalH);
        const botY = top.y + totalH * unitPx;
        line(ctx, [{ x: rx, y: top.y }, { x: rx, y: botY }], SINOPIA, 1.2, null, false);
        ctx.font = `italic 500 11px ${SERIF}`; ctx.fillStyle = SINOPIA; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (let i = 0; i <= nHeads; i++) {
          const y = top.y + Math.min(i, totalH) * unitPx;
          line(ctx, [{ x: rx - 4, y }, { x: rx + 4, y }], SINOPIA, 1.1, null, false);
          if (i > 0 && i <= Math.floor(totalH)) ctx.fillText(String(i), rx - 7, y - unitPx / 2);
        }
        chip(ctx, tk('heads.ruler'), rx, top.y - 14, { W, H, size: 10.5 });
        if (ht && ht.drawing) {
          const dy = top.y + ht.drawing * unitPx;
          line(ctx, [{ x: rx - 5, y: dy }, { x: rx + 10, y: dy }], INK, 1.8, null, false);
          ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.fillText(ht.drawing.toFixed(1), rx + 12, dy);
        }
        ctx.restore();
      }
    }

    // 4) Size measure line (when size !== 'auto')
    if (s.size !== 'auto' && rShow) {
      const map = { head: ['headTop', 'chin', 'measure.head'], torso: ['neck', 'hipC', 'measure.torso'], shoulders: ['shoulderR', 'shoulderL', 'measure.shoulders'], height: ['headTop', 'ankleL', 'measure.height'] };
      const spec = map[s.size];
      if (spec && Rp[spec[0]] && Rp[spec[1]]) {
        const A_ = rPos(Rp[spec[0]]), B_ = rPos(Rp[spec[1]]);
        const pts = Object.values(Rp).filter(Boolean).map(rPos);
        const maxX = pts.length ? Math.max(...pts.map(p => p.x)) + 26 : Math.max(A_.x, B_.x) + 26;
        const a2 = { x: maxX, y: A_.y }, b2 = { x: maxX, y: B_.y };
        line(ctx, [A_, a2], SINOPIA, 1, [2, 3]); line(ctx, [B_, b2], SINOPIA, 1, [2, 3]);
        line(ctx, [a2, b2], SINOPIA, 1.4);
        squareHandle(ctx, a2.x, a2.y, SINOPIA); squareHandle(ctx, b2.x, b2.y, SINOPIA);
        chip(ctx, tk(spec[2]), maxX, (a2.y + b2.y) / 2, { W, H, size: 11 });
      }
    }

    // 5) Points
    const selPts = new Set(selRow && selRow.section === 'body' ? selRow.points : []);
    const involved = new Set(selPts);
    for (const r of rows || []) if (r.section === 'body') (r.points || []).forEach(n => involved.add(n));
    const names = (s.points === true || o.edit) ? BODY_ORDER : [...involved];
    const dim = !!selRow;
    for (const [show, P_, pos, who] of [[rShow, body.R.points, rPos, 'reference'], [dShow, body.D.points, dPos, 'drawing']]) {
      if (!show) continue;
      for (const name of names) {
        const p = P_[name];
        if (!p) continue;
        const q = pos(p), inSel = selPts.has(name);
        ctx.save(); ctx.globalAlpha = dim && !inSel ? 0.5 : 1;
        if (who === 'reference') ring(ctx, q.x, q.y, inSel ? 4.4 : 3.5, SINOPIA, 1.6);
        else dot(ctx, q.x, q.y, inSel ? 3.5 : 2.7, INK);
        if (edited(who, name)) line(ctx, [{ x: q.x + 5, y: q.y + 6 }, { x: q.x + 9, y: q.y + 1.5 }], INK, 1.3, null, true);
        ctx.restore();
        hits.push({ kind: 'pt', who, name, x: q.x, y: q.y, r: hitR + (inSel ? 3 : 0) });
      }
    }

    // 6) Arrows, brackets, angle arcs, tags (drawing pane)
    if (slot === 'drawing' && dShow) {
      const tags = [];
      for (const r of rows || []) {
        if (r.section !== 'body') continue;
        const on = selRow === r, alpha = dim && !on ? 0.5 : 1, col = r.severity === 'major' ? VERMILION : SINOPIA, wd = r.severity === 'major' ? 2.3 : 1.7;
        const tails = [];
        if (s.arrows) {
          for (const { ar, light } of r.arrows || []) {
            const tail = dPos(ar.drawing.from), f = rPos(ar.reference.from), t = rPos(ar.reference.to);
            const head = { x: tail.x + (t.x - f.x), y: tail.y + (t.y - f.y) };
            ctx.save(); ctx.globalAlpha = alpha * (light ? 0.6 : 1);
            arrow(ctx, tail, head, light ? SINOPIA : col, light ? 1.5 : wd);
            ctx.restore();
            if (!light) tails.push(tail);
          }
        }
        if (!tails.length && r.points && r.points.length) {
          const p0 = Dp[r.points[r.points.length - 1]] || Dp[r.points[0]];
          if (p0) tails.push(dPos(p0));
        }
        if (tails.length) {
          const c = tails.reduce((m, p) => ({ x: m.x + p.x / tails.length, y: m.y + p.y / tails.length }), { x: 0, y: 0 });
          tags.push({ r, on, alpha, x: c.x + 18, y: c.y - 14 });
        }
      }
      if (selRow && selRow.section === 'body' && selRow.primary) {
        const it = selRow.primary;
        if (it.kind === 'length' && it.span && Dp[it.span[0]] && Dp[it.span[1]] && Rp[it.span[0]] && Rp[it.span[1]]) {
          drawSpanBracket(ctx, dPos(Dp[it.span[0]]), dPos(Dp[it.span[1]]), rPos(Rp[it.span[0]]), rPos(Rp[it.span[1]]), selRow.text, selRow.severity, W, H, 28);
        } else if (it.kind === 'angle' && it.span && Dp[it.span[0]] && Dp[it.span[1]] && Rp[it.span[0]] && Rp[it.span[1]]) {
          drawAngleMark(ctx, dPos(Dp[it.span[0]]), dPos(Dp[it.span[1]]), rPos(Rp[it.span[0]]), rPos(Rp[it.span[1]]), Math.round(Math.abs(it.value)) + '°', selRow.severity === 'major', W, H);
        }
      }
      placeTags(ctx, tags, W, H, hits);
    }

    // 7) Pin reticle
    if (s.pin !== 'auto' && al.pin && al.pin.reference && al.pin.drawing) {
      const pins = [];
      if (ov) { if (rShow) pins.push(['reference', rPos(al.pin.reference)]); else if (dShow) pins.push(['drawing', dPos(al.pin.drawing)]); }
      else pins.push(slot === 'drawing' ? ['drawing', dPos(al.pin.drawing)] : ['reference', rPos(al.pin.reference)]);
      for (const [who, q] of pins) { pinMark(ctx, q.x, q.y); hits.push({ kind: 'pin', who, x: q.x, y: q.y, r: o.touch ? 26 : 16 }); }
    }
  }

  // ========================================================================================== HAND MARKS
  const HAND_AXES = [
    ['wrist', 'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip'],
    ['wrist', 'indexKnuckle', 'indexPip', 'indexDip', 'indexTip'],
    ['wrist', 'middleKnuckle', 'middlePip', 'middleDip', 'middleTip'],
    ['wrist', 'ringKnuckle', 'ringPip', 'ringDip', 'ringTip'],
    ['wrist', 'littleKnuckle', 'littlePip', 'littleDip', 'littleTip'],
  ];

  function drawHand(ctx, hand, o) {
    if (!hand || !hand.ok) return;
    const { slot, dShow, rShow, dPos, rPos, W, H, ov, hits, hitR, selRow, rows, s, tk, edited } = o;
    const Dp = hand.Dp, Rp = hand.Rp, al = hand.al;

    // 1) Knuckles line & finger axes
    if (s.knuckles !== false) {
      for (const [show, P_, pos, col, dash] of [[rShow, Rp, rPos, SINOPIA, [5, 4]], [dShow, Dp, dPos, INK, null]]) {
        if (!show) continue;
        ctx.save(); ctx.globalAlpha = 0.5;
        if (P_.indexKnuckle && P_.littleKnuckle) {
          const kn = ['indexKnuckle', 'middleKnuckle', 'ringKnuckle', 'littleKnuckle'].map(n => P_[n]).filter(Boolean).map(pos);
          line(ctx, kn, col, 1.3, dash, false);
        }
        for (const chain of HAND_AXES) {
          const pts = chain.map(n => P_[n]).filter(Boolean).map(pos);
          if (pts.length >= 2) line(ctx, pts, col, 0.9, dash, false);
        }
        ctx.restore();
      }
    }

    // 2) Selected finger highlighter wash on reference pane (Side layout)
    if (rShow && !ov && selRow && selRow.section === 'hands' && selRow.primary && selRow.primary.part) {
      const f = selRow.primary.part;
      if (['index', 'middle', 'ring', 'little', 'thumb'].includes(f)) {
        const kn = f === 'thumb' ? (Rp.thumbMcp ? 'thumbMcp' : 'wrist') : f + 'Knuckle', tp = f + 'Tip';
        if (Rp[kn] && Rp[tp]) {
          ctx.save(); ctx.strokeStyle = 'rgba(241, 220, 122, 0.65)'; ctx.lineWidth = 14; ctx.lineCap = 'round';
          const a = rPos(Rp[kn]), b = rPos(Rp[tp]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
        }
      }
    }

    // 3) Points
    const NAMES = DC.HandProportions.NAMES;
    const dim = !!selRow, selPts = new Set(selRow && selRow.section === 'hands' ? selRow.points : []);
    for (const [show, fs, P_, pos, who] of [[rShow, hand.R, Rp, rPos, 'reference'], [dShow, hand.D, Dp, dPos, 'drawing']]) {
      if (!show) continue;
      for (const name of NAMES) {
        const p = P_[name];
        if (!p) continue;
        const q = pos(p), inSel = selPts.has(name), interp = !!(fs.interpolated && fs.interpolated[name]);
        ctx.save(); ctx.globalAlpha = (dim && !inSel ? 0.5 : 1) * (interp ? 0.6 : 1);
        if (who === 'reference') ring(ctx, q.x, q.y, inSel ? 4.2 : 3.2, SINOPIA, interp ? 1.1 : 1.5);
        else if (interp) ring(ctx, q.x, q.y, 2.8, INK, 1.2);
        else dot(ctx, q.x, q.y, inSel ? 3.5 : 2.7, INK);
        if (edited(who, name)) line(ctx, [{ x: q.x + 5, y: q.y + 6 }, { x: q.x + 9, y: q.y + 1.5 }], INK, 1.3, null, true);
        ctx.restore();
        if (!interp) hits.push({ kind: 'pt', who, name, x: q.x, y: q.y, r: hitR + (inSel ? 3 : 0) });
      }
    }

    // 4) Arrows, brackets, angles, tags
    if (slot === 'drawing' && dShow) {
      const tags = [];
      for (const r of rows || []) {
        if (r.section !== 'hands') continue;
        const on = selRow === r, alpha = dim && !on ? 0.5 : 1, col = r.severity === 'major' ? VERMILION : SINOPIA, wd = r.severity === 'major' ? 2.3 : 1.7;
        const tails = [];
        if (s.arrows) {
          for (const { ar, light } of r.arrows || []) {
            const tail = dPos(ar.drawing.from), f = rPos(ar.reference.from), t = rPos(ar.reference.to);
            const head = { x: tail.x + (t.x - f.x), y: tail.y + (t.y - f.y) };
            ctx.save(); ctx.globalAlpha = alpha * (light ? 0.6 : 1);
            arrow(ctx, tail, head, light ? SINOPIA : col, light ? 1.5 : wd);
            ctx.restore();
            if (!light) tails.push(tail);
          }
        }
        if (!tails.length && r.points && r.points.length) {
          const p0 = Dp[r.points[r.points.length - 1]] || Dp[r.points[0]];
          if (p0) tails.push(dPos(p0));
        }
        if (tails.length) {
          const c = tails.reduce((m, p) => ({ x: m.x + p.x / tails.length, y: m.y + p.y / tails.length }), { x: 0, y: 0 });
          tags.push({ r, on, alpha, x: c.x + 16, y: c.y - 12 });
        }
      }
      if (selRow && selRow.section === 'hands' && selRow.primary) {
        const it = selRow.primary;
        if (it.kind === 'length' && it.span && Dp[it.span[0]] && Dp[it.span[1]] && Rp[it.span[0]] && Rp[it.span[1]]) {
          drawSpanBracket(ctx, dPos(Dp[it.span[0]]), dPos(Dp[it.span[1]]), rPos(Rp[it.span[0]]), rPos(Rp[it.span[1]]), selRow.text, selRow.severity, W, H, 24);
        } else if (it.kind === 'angle' && it.span && Dp[it.span[0]] && Dp[it.span[1]] && Rp[it.span[0]] && Rp[it.span[1]]) {
          drawAngleMark(ctx, dPos(Dp[it.span[0]]), dPos(Dp[it.span[1]]), rPos(Rp[it.span[0]]), rPos(Rp[it.span[1]]), Math.round(Math.abs(it.value)) + '°', selRow.severity === 'major', W, H);
        }
      }
      placeTags(ctx, tags, W, H, hits);
    }

    // 5) Size measure & pin
    if (s.size !== 'auto' && rShow) {
      const pair = s.size === 'hand' ? ['wrist', 'middleTip', 'measure.hand'] : ['wrist', 'middleKnuckle', 'measure.palm'];
      if (Rp[pair[0]] && Rp[pair[1]]) {
        const A_ = rPos(Rp[pair[0]]), B_ = rPos(Rp[pair[1]]);
        const maxX = Math.max(A_.x, B_.x) + 34;
        line(ctx, [A_, { x: maxX, y: A_.y }], SINOPIA, 1, [2, 3]); line(ctx, [B_, { x: maxX, y: B_.y }], SINOPIA, 1, [2, 3]);
        line(ctx, [{ x: maxX, y: A_.y }, { x: maxX, y: B_.y }], SINOPIA, 1.4);
        squareHandle(ctx, maxX, A_.y, SINOPIA); squareHandle(ctx, maxX, B_.y, SINOPIA);
        chip(ctx, tk(pair[2]), maxX, (A_.y + B_.y) / 2, { W, H, size: 11 });
      }
    }
    if (s.pin !== 'auto' && al.pin && al.pin.reference && al.pin.drawing) {
      const pins = [];
      if (ov) { if (rShow) pins.push(['reference', rPos(al.pin.reference)]); else if (dShow) pins.push(['drawing', dPos(al.pin.drawing)]); }
      else pins.push(slot === 'drawing' ? ['drawing', dPos(al.pin.drawing)] : ['reference', rPos(al.pin.reference)]);
      for (const [who, q] of pins) { pinMark(ctx, q.x, q.y); hits.push({ kind: 'pin', who, x: q.x, y: q.y, r: o.touch ? 26 : 16 }); }
    }
  }

  // ---- Live skeleton/hand preview while placing points in coach
  function drawCoachPreview(ctx, placing, pos) {
    const pts = placing.pts || {};
    const col = placing.slot === 'reference' ? SINOPIA : INK;
    if (placing.kind === 'body') {
      ctx.save(); ctx.globalAlpha = 0.5;
      for (const [a, b] of BODY_BONES) if (pts[a] && pts[b]) line(ctx, [pos(pts[a]), pos(pts[b])], col, 1.2, null, false);
      ctx.restore();
    } else if (placing.kind === 'hand') {
      ctx.save(); ctx.globalAlpha = 0.5;
      for (const [a, b] of [['wrist', 'indexKnuckle'], ['indexKnuckle', 'littleKnuckle'], ['indexKnuckle', 'indexTip'], ['wrist', 'middleTip'], ['littleKnuckle', 'littleTip'], ['wrist', 'thumbTip']]) {
        if (pts[a] && pts[b]) line(ctx, [pos(pts[a]), pos(pts[b])], col, 1.2, null, false);
      }
      ctx.restore();
    }
  }

  DC.PropMarksP3 = { drawOutline, drawBody, drawHand, drawCoachPreview };
})();
