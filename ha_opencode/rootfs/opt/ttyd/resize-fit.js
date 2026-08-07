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
 *
 * Firefox can also report a window devicePixelRatio that disagrees materially
 * with the active canvas' device-pixel content box in an HA ingress iframe.
 * xterm 5.4 then combines incompatible renderer and canvas dimensions. When
 * that happens, we correct only this terminal's internal DPR service and force
 * xterm's own DPR refresh path; browser-wide devicePixelRatio is never changed.
 */
(function () {
  'use strict';

  var rafId = 0;
  var lastW = -1;
  var lastH = -1;
  var dprObserver;
  var dprCanvas;
  var dprService;
  var effectiveDpr;
  var dprGetter;
  var dprRetryDelays = [0, 200, 600, 1200, 2500, 4000];

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

  function isPositiveNumber(value) {
    return typeof value === 'number' && isFinite(value) && value > 0;
  }

  function findPropertyDescriptor(object, name) {
    while (object) {
      var descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor) return descriptor;
      object = Object.getPrototypeOf(object);
    }
  }

  function getRendererCanvas(renderer) {
    var canvas = renderer && renderer._canvas;
    if (canvas && canvas.nodeName === 'CANVAS') return canvas;

    var layers = renderer && renderer._renderLayers;
    canvas = layers && layers[0] && layers[0].canvas;
    if (!canvas || canvas.nodeName !== 'CANVAS') return;
    if (!canvas.classList || typeof canvas.classList.contains !== 'function') return;
    return canvas.classList.contains('xterm-text-layer') ? canvas : undefined;
  }

  function getDprState() {
    var term = window.term;
    var core = term && term._core;
    var service = core && core._coreBrowserService;
    var render = core && core._renderService;
    var renderer = render && render._renderer && render._renderer.value;
    var canvas = getRendererCanvas(renderer);
    if (!term || !term.element || !term.element.isConnected || !service || !render || !canvas) return;
    if (service.window !== window || !canvas.isConnected || canvas.ownerDocument !== document) return;
    if (typeof render.handleDevicePixelRatioChange !== 'function' || typeof term.fit !== 'function') return;
    if (!Object.isExtensible(service)) return;

    var descriptor = findPropertyDescriptor(Object.getPrototypeOf(service), 'dpr');
    if (!descriptor || !descriptor.configurable || typeof descriptor.get !== 'function') return;

    var ownDescriptor = Object.getOwnPropertyDescriptor(service, 'dpr');
    if (ownDescriptor && (service !== dprService || ownDescriptor.get !== dprGetter)) return;

    var nativeDpr;
    try {
      nativeDpr = descriptor.get.call(service);
    } catch (error) {
      return;
    }
    if (!isPositiveNumber(nativeDpr)) return;

    return {
      term: term,
      service: service,
      render: render,
      canvas: canvas,
      nativeDpr: nativeDpr,
    };
  }

  function getBoxSize(boxes, key, fallback) {
    var box = boxes && boxes[0];
    var value = box && box[key];
    return isPositiveNumber(value) ? value : fallback;
  }

  function restoreNativeDpr(state) {
    if (state.service !== dprService) return;

    var ownDescriptor = Object.getOwnPropertyDescriptor(state.service, 'dpr');
    if (!ownDescriptor || ownDescriptor.get !== dprGetter) return;

    try {
      delete state.service.dpr;
    } catch (error) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(state.service, 'dpr')) return;

    dprService = undefined;
    effectiveDpr = undefined;
    dprGetter = undefined;
    try {
      state.render.handleDevicePixelRatioChange();
      scheduleFit();
    } catch (error) {
      // Never let optional DPR correction break the terminal.
    }
  }

  function applyEffectiveDpr(state, dpr) {
    if (state.service === dprService && Math.abs(dpr - effectiveDpr) < 0.0001) return;

    var previousEffectiveDpr = effectiveDpr;
    var previousGetter = dprGetter;
    effectiveDpr = dpr;
    dprGetter = function () {
      return effectiveDpr;
    };
    try {
      Object.defineProperty(state.service, 'dpr', {
        configurable: true,
        get: dprGetter,
      });
    } catch (error) {
      effectiveDpr = previousEffectiveDpr;
      dprGetter = previousGetter;
      return;
    }

    dprService = state.service;
    try {
      state.render.handleDevicePixelRatioChange();
      scheduleFit();
    } catch (error) {
      // Never let optional DPR correction break the terminal.
    }
  }

  function reconcileDpr(entry) {
    var state = getDprState();
    if (!state || entry.target !== state.canvas) return;

    var cssWidth = getBoxSize(entry.contentBoxSize, 'inlineSize', entry.contentRect && entry.contentRect.width);
    var cssHeight = getBoxSize(entry.contentBoxSize, 'blockSize', entry.contentRect && entry.contentRect.height);
    var deviceWidth = getBoxSize(entry.devicePixelContentBoxSize, 'inlineSize');
    var deviceHeight = getBoxSize(entry.devicePixelContentBoxSize, 'blockSize');
    if (!isPositiveNumber(cssWidth) || !isPositiveNumber(cssHeight) || !isPositiveNumber(deviceWidth) || !isPositiveNumber(deviceHeight)) return;

    var widthDpr = deviceWidth / cssWidth;
    var heightDpr = deviceHeight / cssHeight;
    var roundingTolerance = 1 / cssWidth + 1 / cssHeight + 0.001;
    if (!isPositiveNumber(widthDpr) || !isPositiveNumber(heightDpr) || Math.abs(widthDpr - heightDpr) > roundingTolerance) return;

    var expectedWidth = Math.round(cssWidth * state.nativeDpr);
    var expectedHeight = Math.round(cssHeight * state.nativeDpr);
    if (Math.abs(deviceWidth - expectedWidth) <= 1 && Math.abs(deviceHeight - expectedHeight) <= 1) {
      restoreNativeDpr(state);
      return;
    }

    applyEffectiveDpr(state, (widthDpr + heightDpr) / 2);
  }

  function bindDprObserver() {
    var state = getDprState();
    if (!state || typeof ResizeObserver !== 'function') return;
    if (dprObserver && dprCanvas === state.canvas) return;

    if (dprObserver) dprObserver.disconnect();
    dprObserver = undefined;
    dprCanvas = undefined;

    try {
      dprObserver = new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) reconcileDpr(entries[i]);
      });
      dprObserver.observe(state.canvas, { box: ['device-pixel-content-box'] });
      dprCanvas = state.canvas;
    } catch (error) {
      if (dprObserver) dprObserver.disconnect();
      dprObserver = undefined;
      dprCanvas = undefined;
    }
  }

  /* Only fit when the viewport actually changed size. The document element
     tracks the iframe viewport and is not resized by fit() itself, so this
     both suppresses no-op fits and prevents an observer feedback loop. */
  function onGeometryChange() {
    bindDprObserver();
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

    /* ttyd selects Canvas/WebGL asynchronously after it exposes window.term.
       Recheck briefly until the active renderer canvas is available. */
    for (var i = 0; i < dprRetryDelays.length; i++) {
      setTimeout(bindDprObserver, dprRetryDelays[i]);
    }
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
