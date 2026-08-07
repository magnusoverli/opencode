// Exercises the inline ttyd/xterm ingress workaround without a browser. The
// script is intentionally evaluated as shipped so private xterm guards cannot
// silently drift away from the pinned ttyd 1.7.7 bundle.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const RESIZE_FIT = path.join(__dirname, "..", "rootfs", "opt", "ttyd", "resize-fit.js");
const SOURCE = fs.readFileSync(RESIZE_FIT, "utf8");

function createHarness({ nativeDpr = 2, canvasConnected = true, fitThrows = false } = {}) {
  const observers = [];
  const rafCallbacks = [];
  const timers = [];
  const eventListeners = [];
  let fits = 0;
  let dprRefreshes = 0;

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = undefined;
      this.options = undefined;
      this.disconnected = false;
      observers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(entry) {
      this.callback([entry]);
    }
  }

  const documentElement = { clientWidth: 1200, clientHeight: 800 };
  const document = { documentElement };
  const canvas = {
    nodeName: "CANVAS",
    isConnected: canvasConnected,
    ownerDocument: document,
    classList: { contains: (name) => name === "xterm-text-layer" },
  };
  const renderer = { _renderLayers: [{ canvas }] };
  const render = {
    _renderer: { value: renderer },
    handleDevicePixelRatioChange: () => {
      dprRefreshes++;
    },
  };
  let window;
  class BrowserService {
    constructor() {
      this.window = window;
    }

    get dpr() {
      return this.window.devicePixelRatio;
    }
  }

  const browserService = new BrowserService();
  const term = {
    element: { isConnected: true },
    _core: { _coreBrowserService: browserService, _renderService: render },
    fit: () => {
      fits++;
      if (fitThrows) throw new Error("fit failed");
    },
  };
  window = {
    term,
    devicePixelRatio: nativeDpr,
    addEventListener: (type, callback) => eventListeners.push({ type, callback }),
  };
  browserService.window = window;

  vm.runInNewContext(SOURCE, {
    window,
    document,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: (callback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    Object,
    Math,
    isFinite,
  });

  const observerFor = (target) => observers.find((observer) => observer.target === target);
  const runTimersThrough = (delay) => {
    for (let i = 0; i < timers.length; i++) {
      const timer = timers[i];
      if (!timer || timer.delay > delay) continue;
      timers[i] = undefined;
      timer.callback();
    }
  };
  const flushRaf = () => {
    while (rafCallbacks.length) rafCallbacks.shift()();
  };
  const resetCalls = () => {
    fits = 0;
    dprRefreshes = 0;
  };
  const entry = (target, cssWidth, cssHeight, deviceWidth, deviceHeight) => ({
    target,
    contentBoxSize: [{ inlineSize: cssWidth, blockSize: cssHeight }],
    devicePixelContentBoxSize: [{ inlineSize: deviceWidth, blockSize: deviceHeight }],
    contentRect: { width: cssWidth, height: cssHeight },
  });

  return {
    browserService,
    canvas,
    documentElement,
    entry,
    eventListeners,
    flushRaf,
    get dprRefreshes() {
      return dprRefreshes;
    },
    get fits() {
      return fits;
    },
    observerFor,
    resetCalls,
    runTimersThrough,
    window,
  };
}

function startDprObserver(harness) {
  harness.runTimersThrough(0);
  harness.flushRaf();
  harness.resetCalls();
  const observer = harness.observerFor(harness.canvas);
  assert.ok(observer, "the active xterm canvas should be observed");
  assert.equal(observer.options.box.length, 1);
  assert.equal(observer.options.box[0], "device-pixel-content-box");
  return observer;
}

test("corrects only xterm's DPR service when canvas pixels materially disagree", () => {
  const harness = createHarness();
  const observer = startDprObserver(harness);

  observer.emit(harness.entry(harness.canvas, 200, 100, 250, 125));

  assert.equal(harness.window.devicePixelRatio, 2, "the browser-wide DPR must remain untouched");
  assert.equal(harness.browserService.dpr, 1.25);
  assert.equal(harness.dprRefreshes, 1, "xterm must remeasure with the corrected DPR");
  assert.equal(harness.fits, 0, "fit is deferred with the existing rAF coalescing");
  harness.flushRaf();
  assert.equal(harness.fits, 1);

  observer.emit(harness.entry(harness.canvas, 200, 100, 400, 200));
  assert.equal(harness.browserService.dpr, 2, "a matching canvas restores the native DPR getter");
  assert.equal(Object.hasOwn(harness.browserService, "dpr"), false);
  assert.equal(harness.dprRefreshes, 2);
});

test("ignores normal device-pixel rounding differences", () => {
  const harness = createHarness({ nativeDpr: 1.25 });
  const observer = startDprObserver(harness);

  observer.emit(harness.entry(harness.canvas, 200, 100, 251, 126));

  assert.equal(harness.browserService.dpr, 1.25);
  assert.equal(Object.hasOwn(harness.browserService, "dpr"), false);
  assert.equal(harness.dprRefreshes, 0);
  harness.flushRaf();
  assert.equal(harness.fits, 0);
});

test("fails closed when the active renderer canvas cannot be verified", () => {
  const harness = createHarness({ canvasConnected: false });

  harness.runTimersThrough(4000);
  harness.flushRaf();

  assert.equal(harness.observerFor(harness.canvas), undefined);
  assert.equal(harness.browserService.dpr, 2);
  assert.equal(Object.hasOwn(harness.browserService, "dpr"), false);
  assert.equal(harness.dprRefreshes, 0);
});

test("keeps geometry fits coalesced and contains terminal fit failures", () => {
  const harness = createHarness({ fitThrows: true });

  harness.flushRaf();
  harness.resetCalls();
  const geometryObserver = harness.observerFor(harness.documentElement);
  assert.ok(geometryObserver, "the ingress viewport should remain observed");

  assert.doesNotThrow(() => {
    geometryObserver.emit({ target: harness.documentElement });
    harness.documentElement.clientWidth = 1199;
    geometryObserver.emit({ target: harness.documentElement });
    geometryObserver.emit({ target: harness.documentElement });
    harness.flushRaf();
  });
  assert.equal(harness.fits, 1, "multiple viewport notifications should fit once per frame");
  assert.ok(harness.eventListeners.some(({ type }) => type === "orientationchange"));
});
