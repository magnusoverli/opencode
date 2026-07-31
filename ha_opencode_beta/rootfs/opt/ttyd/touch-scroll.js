/*
 * Touch scrolling for ttyd/xterm.js inside Home Assistant ingress.
 *
 * Full-screen terminal apps such as OpenCode enable mouse reporting, so touch
 * drag gestures are delivered to the terminal instead of scrolling the TUI.
 * On touch devices, translate a one-finger vertical drag into wheel events;
 * desktop browsers and multi-touch gestures are left alone.
 */
(function () {
  'use strict';

  if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;

  var MIN_DELTA = 8;
  var termRoot = null;
  var active = false;
  var lastY = 0;
  var pendingDelta = 0;

  function dispatchWheel(x, y, deltaY) {
    var target = document.elementFromPoint(x, y) || termRoot;
    if (!target) return;

    target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        deltaMode: 0,
        deltaY: deltaY,
      })
    );
  }

  function reset() {
    active = false;
    pendingDelta = 0;
  }

  function setup(term) {
    termRoot = term.element;
    if (!termRoot) return;

    termRoot.addEventListener(
      'touchstart',
      function (event) {
        if (event.touches.length !== 1) {
          reset();
          return;
        }

        active = true;
        pendingDelta = 0;
        lastY = event.touches[0].clientY;
      },
      { passive: true }
    );

    termRoot.addEventListener(
      'touchmove',
      function (event) {
        if (!active || event.touches.length !== 1) {
          reset();
          return;
        }

        var touch = event.touches[0];
        pendingDelta += lastY - touch.clientY;
        lastY = touch.clientY;

        if (Math.abs(pendingDelta) < MIN_DELTA) return;

        var deltaY = pendingDelta;
        pendingDelta = 0;

        if (event.cancelable) event.preventDefault();
        dispatchWheel(touch.clientX, touch.clientY, deltaY);
      },
      { passive: false }
    );

    termRoot.addEventListener('touchend', reset, { passive: true });
    termRoot.addEventListener('touchcancel', reset, { passive: true });
  }

  var tries = 0;
  (function waitForTerm() {
    if (window.term && window.term.element) {
      try {
        setup(window.term);
      } catch (error) {
        // Never let optional touch support break the terminal.
      }
    } else if (++tries < 200) {
      setTimeout(waitForTerm, 50);
    }
  })();
})();
