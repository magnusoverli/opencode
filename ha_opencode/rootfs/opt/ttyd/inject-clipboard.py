#!/usr/bin/env python3
"""Build-time helper: inject local scripts into ttyd's index page.

ttyd serves a single self-contained HTML page (all JS/CSS inlined, compiled
into the binary), so the only way to extend it is to dump the served page and
splice our script in before </body>. Usage:

    inject-clipboard.py <dumped-index.html> <output.html> <script.js> [script.js ...]
"""

import sys


def patch_reconnect(html: str) -> str:
    """Bounded recovery for errors on established ttyd 1.7.7 connections."""
    replacements = (
        # An initial failed connection still requires manual retry. Only a
        # previously opened terminal may automatically reattach its tmux client.
        ('(()=>this.doReconnect=!1)',
         '(()=>this.doReconnect=this.opened&&this.reconnect)'),
        ('this.doReconnect=this.reconnect,this.initListeners()',
         'this.haReconnectAttempts=0,this.doReconnect=this.reconnect,this.initListeners()'),
        ('1e3!==e.code&&s)r.showOverlay("Reconnecting..."),t().then(i);else',
         '1e3!==e.code&&s&&(this.haReconnectAttempts||0)<5){'
         'this.haReconnectAttempts=(this.haReconnectAttempts||0)+1;'
         'r.showOverlay("Reconnecting...");'
         'setTimeout(()=>t().then(i),Math.min(1000*2**(this.haReconnectAttempts-1),8000))'
         '}else'),
        ('s.dispose(),r.showOverlay("Reconnecting..."),t().then(i)',
         's.dispose(),this.haReconnectAttempts=0,r.showOverlay("Reconnecting..."),t().then(i)'),
    )
    for before, after in replacements:
        if html.count(before) != 1:
            raise ValueError("unexpected pinned ttyd reconnect source")
        html = html.replace(before, after)
    return html


def main() -> None:
    if len(sys.argv) < 4:
        sys.exit(__doc__ or "usage error")

    src = sys.argv[1]
    dst = sys.argv[2]
    js_paths = sys.argv[3:]

    with open(src, encoding="utf-8") as f:
        html = f.read()

    if "</body>" not in html:
        sys.exit("error: ttyd index page has no </body> - ttyd layout changed?")

    html = patch_reconnect(html)

    script_blocks = []
    for js_path in js_paths:
        with open(js_path, encoding="utf-8") as f:
            js = f.read()

        if "</script" in js.lower():
            sys.exit(f"error: {js_path} must not contain '</script' (inlined)")

        script_blocks.append(f"<script>\n{js}\n</script>")

    html = html.replace("</body>", "\n".join(script_blocks) + "</body>", 1)

    with open(dst, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {dst} ({len(html)} bytes)")


if __name__ == "__main__":
    main()
