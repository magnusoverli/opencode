// Installed ahead of ttyd's pinned frontend by inject-clipboard.py.
class HaTerminalReconnect {
  constructor(terminal) {
    this.terminal = terminal;
    this.manualOpen();
  }

  manualOpen() {
    this.page = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    this.resume = false;
    this.established = false;
    this.attempts = 0;
  }

  url(original) {
    const url = new URL(original);
    // Never forward ambient page args to a ttyd command.
    url.search = "";
    url.searchParams.set("arg", `${this.resume ? "resume" : "open"}-${this.page}`);
    this.received = false;
    return url.href;
  }

  output() {
    if (this.received) return;
    if (this.redraw) {
      this.terminal.terminal.reset();
      this.terminal.terminal.options.disableStdin = false;
      this.terminal.overlayAddon.showOverlay("Reconnected", 300);
      this.redraw = false;
    }
    this.established = this.received = true;
    this.attempts = 0;
  }

  manual(message = "Press ⏎ to Reconnect") {
    const t = this.terminal;
    t.terminal.options.disableStdin = false;
    const key = t.terminal.onKey(({ domEvent }) => {
      if (domEvent.key !== "Enter") return;
      key.dispose();
      this.manualOpen();
      t.overlayAddon.showOverlay("Reconnecting...");
      t.refreshToken().then(t.connect);
    });
    t.overlayAddon.showOverlay(message);
  }

  closed(event) {
    const t = this.terminal;
    t.dispose();
    // HA can translate a severed connection into 1000. After an established
    // terminal, try attach-only. A clean close of a silent resume means the
    // session may have ended or detached: leave creation to the user.
    if (!t.reconnect || !this.established || (this.resume && !this.received && event.code === 1000))
      return this.manual();
    this.resume = true;
    this.retry();
  }

  retry() {
    const t = this.terminal;
    if (this.attempts >= 5) return this.manual();
    t.overlayAddon.showOverlay("Reconnecting...");
    setTimeout(async () => {
      try {
        const response = await fetch(t.options.tokenUrl, { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if ([401, 403].includes(response.status) || response.redirected)
          return this.manual("Reopen the terminal in Home Assistant to reconnect");
        if (!response.ok) return this.retry();
        // An expired Ingress session can also send an HTML login page.
        const auth = await response.json().catch(() => null);
        if (typeof auth?.token !== "string")
          return this.manual("Reopen the terminal in Home Assistant to reconnect");
        t.token = auth.token;
        t.connect();
      } catch { this.retry(); }
    }, Math.min(1000 * 2 ** this.attempts++, 8000));
  }
}
