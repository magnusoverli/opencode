/*
 * Clipboard glue for ttyd/xterm.js inside the Home Assistant ingress iframe.
 *
 * Injected inline into ttyd's index page at image build time (see Dockerfile)
 * and served via `ttyd -I`. Fixes two gaps in stock ttyd 1.7.7:
 *
 * OSC 52 (copy out of the terminal): applications set the clipboard with an
 * escape sequence that stock ttyd ignores, so copying inside OpenCode (which
 * has mouse reporting on, making browser-side selection impossible without
 * Shift) never reached the system clipboard. We register a handler and
 * forward the text to the browser. Browsers only allow silent clipboard
 * writes from secure contexts (HTTPS) — on plain HTTP, or when the write is
 * rejected (Firefox/Safari require a user gesture), we show a one-click
 * "Copy" toast: the click is a user gesture, where the legacy
 * document.execCommand('copy') path still works.
 *
 * Ctrl+V (paste into the terminal): xterm.js turns plain Ctrl+V into a ^V
 * byte for the application instead of pasting. We let the keystroke fall
 * through to the browser, which pastes natively into xterm.js' hidden
 * textarea — this works on HTTP too, since native paste events need no
 * clipboard permission. Ctrl+Shift+V, Shift+Insert, middle-click and
 * right-click paste keep working as before.
 */
(function () {
  'use strict';

  var toast = null;
  var hideTimer = null;
  var pendingText = '';

  function decodeBase64Utf8(b64) {
    try {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /* Copy via a temporary textarea + execCommand: deprecated, but the only
     clipboard write that works outside secure contexts — and only inside a
     user gesture, which is why it runs from the toast's click handler. */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      /* fall through */
    }
    document.body.removeChild(ta);
    if (window.term) window.term.focus();
    return ok;
  }

  function hideToast() {
    if (toast) toast.style.display = 'none';
  }

  function showToast() {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:1000;' +
        'padding:10px 16px;border-radius:6px;cursor:pointer;' +
        'background:#1d99f3;color:#fff;' +
        'font:13px/1.4 -apple-system,system-ui,sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.4);' +
        'user-select:none;-webkit-user-select:none';
      toast.addEventListener('click', function () {
        var ok = legacyCopy(pendingText);
        toast.textContent = ok ? 'Copied ✓' : 'Copy failed';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideToast, 1500);
      });
      document.body.appendChild(toast);
    }
    toast.textContent = '📋 Copy to clipboard';
    toast.style.display = 'block';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideToast, 15000);
  }

  function writeClipboard(text) {
    pendingText = text;
    if (window.isSecureContext && navigator.clipboard) {
      /* OSC 52 arrives asynchronously from the pty, outside any user
         gesture; Firefox/Safari reject such writes, so fall back to the
         toast on rejection. */
      navigator.clipboard.writeText(text).then(hideToast, showToast);
    } else {
      showToast();
    }
  }

  function setup(term) {
    /* OSC 52 payload is "<selection>;<base64 text>". A "?" payload is a
       clipboard read request — unsupported here, swallowed. Returning true
       marks the sequence as handled. */
    term.parser.registerOscHandler(52, function (data) {
      var sep = data.indexOf(';');
      if (sep === -1) return true;
      var payload = data.slice(sep + 1);
      if (payload === '' || payload === '?') return true;
      var text = decodeBase64Utf8(payload);
      if (text) writeClipboard(text);
      return true;
    });

    /* Plain Ctrl+V: returning false stops xterm.js from emitting ^V, and
       since the keydown is not cancelled the browser performs its native
       paste into the focused hidden textarea, which xterm.js then handles
       as a terminal paste (bracketed paste included). */
    term.attachCustomKeyEventHandler(function (ev) {
      if (
        ev.type === 'keydown' &&
        ev.ctrlKey &&
        !ev.shiftKey &&
        !ev.altKey &&
        !ev.metaKey &&
        (ev.key === 'v' || ev.key === 'V')
      ) {
        return false;
      }
      return true;
    });
  }

  /* ttyd exposes the terminal as window.term once its app has initialised;
     this script runs before that, so poll briefly (up to ~10s). */
  var tries = 0;
  (function waitForTerm() {
    if (window.term && window.term.parser) {
      setup(window.term);
    } else if (++tries < 200) {
      setTimeout(waitForTerm, 50);
    }
  })();
})();
