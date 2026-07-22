/*
 * Auto-fit ttyd/xterm.js to the Home Assistant ingress iframe.
 *
 * Injected inline into ttyd's index page at image build time (see Dockerfile)
 * alongside the clipboard and touch-scroll fixes. Closes a resize gap in stock
 * ttyd 1.7.7 when it runs inside the HA ingress iframe.
 *
 * ttyd re-fits the terminal only from a window 'resize' event:
 *
 *     register(addEventListener(window, 'resize', () => fitAddon.fit()));
 *
 * Home Assistant, however, resizes the add-on iframe from its own JavaScript
 * (toggling the sidebar, the initial panel layout) without the iframe's window
 * ever firing 'resize'. So fitAddon.fit() never re-runs and the pane keeps its
 * initial, oversized dimensions — content then overflows the viewport on the
 * right and top (e.g. Ctrl+P's "Session" header sits above the visible area).
 *
 * We watch the document element with a ResizeObserver, which fires on the
 * iframe-driven size changes that 'resize' misses, and call ttyd's own
 * window.term.fit() to recompute cols/rows. Work is coalesced through
 * requestAnimationFrame and gated on an actual dimension change, so redundant
 * fits — and any ResizeObserver feedback loop — are avoided. This is additive
 * to ttyd's stock window-resize handler, which keeps working when it does fire.
 */
(function () {
  'use strict';

  var rafId = 0;
  var lastW = -1;
  var lastH = -1;

  function fitNow() {
    rafId = 0;
    if (!window.term || typeof window.term.fit !== 'function') return;
    try {
      window.term.fit();
    } catch (error) {
      // Never let optional auto-fit break the terminal.
    }
  }

  function scheduleFit() {
    if (rafId) return;
    rafId = requestAnimationFrame(fitNow);
  }

  /* Only fit when the viewport actually changed size. The document element
     tracks the iframe viewport and is not resized by fit() itself, so this
     both suppresses no-op fits and prevents an observer feedback loop. */
  function onGeometryChange() {
    var el = document.documentElement;
    var w = el.clientWidth;
    var h = el.clientHeight;
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    scheduleFit();
  }

  function setup() {
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(onGeometryChange).observe(document.documentElement);
    }

    /* Secondary signals for environments/gestures where neither the classic
       window 'resize' nor the ResizeObserver fires reliably (mobile zoom,
       on-screen keyboard, orientation change). */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleFit);
    }
    window.addEventListener('orientationchange', scheduleFit);

    /* Correct the initial, build-time-dumped dimensions right away, then once
       more after first layout/connect settles. */
    scheduleFit();
    setTimeout(scheduleFit, 500);
  }

  /* ttyd exposes window.term (with our-side window.term.fit) once its app has
     initialised; this script runs before that, so poll briefly (up to ~10s). */
  var tries = 0;
  (function waitForTerm() {
    if (window.term && typeof window.term.fit === 'function') {
      setup();
    } else if (++tries < 200) {
      setTimeout(waitForTerm, 50);
    }
  })();
})();
