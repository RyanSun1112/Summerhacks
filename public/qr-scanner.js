/* Shared in-browser QR scanner for Pulse (jsQR + getUserMedia).
   Requires window.jsQR from the CDN script loaded before this file.
   Usage: PulseQr.open({ onScan(url) })  — navigates via onScan, or
          PulseQr.open()                 — location.assign(decoded join URL) */
(function (global) {
  'use strict';

  let stream = null;
  let raf = 0;
  let overlay = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let errEl = null;
  let active = false;
  let onScanCb = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'pulseQrOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Scan venue QR code');
    overlay.innerHTML = [
      '<style>',
      '#pulseQrOverlay{position:fixed;inset:0;z-index:9999;display:none;flex-direction:column;',
      'align-items:center;justify-content:center;background:rgba(8,10,24,.94);',
      'padding:max(16px,env(safe-area-inset-top)) 16px max(20px,env(safe-area-inset-bottom));',
      'font-family:\'Space Grotesk\',system-ui,-apple-system,sans-serif;color:#F0EFF7}',
      '#pulseQrOverlay.on{display:flex}',
      '#pulseQrOverlay .pq-frame{position:relative;width:min(86vw,360px);aspect-ratio:1;',
      'border-radius:14px;overflow:hidden;background:#000;box-shadow:0 20px 60px rgba(0,0,0,.55)}',
      '#pulseQrOverlay video{width:100%;height:100%;object-fit:cover;display:block}',
      '#pulseQrOverlay canvas{display:none}',
      '#pulseQrOverlay .pq-view{pointer-events:none;position:absolute;inset:14%;',
      'border:2px solid rgba(240,239,247,.35);border-radius:8px;',
      'box-shadow:0 0 0 999px rgba(8,10,24,.45)}',
      '#pulseQrOverlay .pq-view::before,#pulseQrOverlay .pq-view::after{content:\'\';position:absolute;',
      'width:22px;height:22px;border:3px solid #3B4FE0}',
      '#pulseQrOverlay .pq-view::before{top:-2px;left:-2px;border-right:0;border-bottom:0;border-radius:6px 0 0 0}',
      '#pulseQrOverlay .pq-view::after{bottom:-2px;right:-2px;border-left:0;border-top:0;border-radius:0 0 6px 0}',
      '#pulseQrOverlay .pq-lab{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;',
      'color:#7E7D99;margin-bottom:12px}',
      '#pulseQrOverlay .pq-hint{margin-top:16px;font-size:14px;color:#7E7D99;text-align:center;max-width:22em;line-height:1.45}',
      '#pulseQrOverlay .pq-err{margin-top:12px;font-size:14px;color:#FF8A6B;text-align:center;max-width:22em;line-height:1.45;min-height:1.2em}',
      '#pulseQrOverlay .pq-cancel{margin-top:18px;min-height:48px;padding:12px 28px;border-radius:8px;',
      'border:1px solid rgba(240,239,247,.12);background:transparent;color:#F0EFF7;cursor:pointer;',
      'font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}',
      '#pulseQrOverlay .pq-cancel:active{border-color:#3B4FE0}',
      '</style>',
      '<div class="pq-lab">Scan venue QR</div>',
      '<div class="pq-frame">',
      '  <video playsinline muted autoplay></video>',
      '  <canvas></canvas>',
      '  <div class="pq-view" aria-hidden="true"></div>',
      '</div>',
      '<p class="pq-hint">Point at a Pulse check-in poster. The camera stays on this device — nothing is uploaded.</p>',
      '<div class="pq-err" id="pulseQrErr"></div>',
      '<button type="button" class="pq-cancel" id="pulseQrCancel">Cancel</button>'
    ].join('');
    document.body.appendChild(overlay);
    video = overlay.querySelector('video');
    canvas = overlay.querySelector('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    errEl = overlay.querySelector('#pulseQrErr');
    overlay.querySelector('#pulseQrCancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  }

  function setErr(msg) {
    if (errEl) errEl.textContent = msg || '';
  }

  function stopStream() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (stream) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      stream = null;
    }
    if (video) {
      try { video.pause(); } catch (_) {}
      video.srcObject = null;
    }
  }

  function close() {
    active = false;
    stopStream();
    if (overlay) overlay.classList.remove('on');
    setErr('');
    onScanCb = null;
  }

  function resolveJoinUrl(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    let u;
    try { u = new URL(raw, location.origin); } catch (_) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Venue/event posters encode join.html (optionally ?v= / ?zone=).
    if (!/\/join\.html$/i.test(u.pathname)) return null;
    return u.href;
  }

  function tick() {
    if (!active) return;
    if (video.readyState >= 2) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w && h) {
        if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = global.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          const href = resolveJoinUrl(code.data);
          if (href) {
            const cb = onScanCb;
            close();
            if (cb) cb(href);
            else location.assign(href);
            return;
          }
          setErr('That QR isn\'t a Pulse check-in code. Try a venue poster.');
        }
      }
    }
    raf = requestAnimationFrame(tick);
  }

  async function open(opts) {
    opts = opts || {};
    onScanCb = typeof opts.onScan === 'function' ? opts.onScan : null;
    ensureDom();
    setErr('');
    if (typeof global.jsQR !== 'function') {
      setErr('QR library failed to load. Check your connection and try again.');
      overlay.classList.add('on');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErr('This browser can\'t open the camera. Use the device Camera app on a printed QR, or open join.html directly.');
      overlay.classList.add('on');
      return;
    }
    stopStream();
    active = true;
    overlay.classList.add('on');
    try {
      // Prefer rear camera; fall back to any video if facingMode is refused.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } }
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    } catch (e) {
      active = false;
      stopStream();
      const denied = /NotAllowed|Permission|denied/i.test(e && (e.name + e.message));
      setErr(denied
        ? 'Camera permission denied. Allow camera access for this site, or scan the poster with your Camera app.'
        : ('Could not open the camera: ' + ((e && e.message) || 'unknown error')));
    }
  }

  global.PulseQr = { open, close };
})(typeof window !== 'undefined' ? window : globalThis);
