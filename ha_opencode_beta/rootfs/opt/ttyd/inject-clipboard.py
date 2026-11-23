#!/usr/bin/env python3
"""Build-time helper: inject local scripts into ttyd's index page.

ttyd serves a single self-contained HTML page (all JS/CSS inlined, compiled
into the binary), so the only way to extend it is to dump the served page and
splice our script in before </body>. Usage:

    inject-clipboard.py <dumped-index.html> <output.html> <script.js> [script.js ...]
"""

import sys
from pathlib import Path


def patch_reconnect(html: str) -> str:
    """Bounded recovery for errors on established ttyd 1.7.7 connections."""
    replacements = (
        ('connect(){this.socket=new WebSocket(this.options.wsUrl,["tty"])',
         'connect(){this.haRecovery??=new HaTerminalReconnect(this);'
         'this.socket=new WebSocket(this.haRecovery.url(this.options.wsUrl),["tty"])'),
        ('i.reset(),i.options.disableStdin=!1,s.showOverlay("Reconnected",300)',
         'this.haRecovery.redraw=true,i.options.disableStdin=!0'),
        ('case f.OUTPUT:this.writeFunc(r);break;',
         'case f.OUTPUT:r.byteLength&&this.haRecovery.output();this.writeFunc(r);break;'),
        ('const{refreshToken:t,connect:i,doReconnect:s,overlayAddon:r}=this;'
         'if(r.showOverlay("Connection Closed"),this.dispose(),1e3!==e.code&&s)'
         'r.showOverlay("Reconnecting..."),t().then(i);else{const{terminal:e}=this,'
         's=e.onKey((e=>{"Enter"===e.domEvent.key&&(s.dispose(),r.showOverlay("Reconnecting..."),'
         't().then(i))}));r.showOverlay("Press ⏎ to Reconnect")}',
         'this.haRecovery.closed(e)'),
    )
    for before, after in replacements:
        if html.count(before) != 1:
            raise ValueError("unexpected pinned ttyd reconnect source")
        html = html.replace(before, after)
    helper = Path(__file__).with_name("reconnect.js").read_text(encoding="utf-8")
    if "<script" not in html or "</script" in helper.lower():
        raise ValueError("unexpected ttyd script layout")
    return html.replace("<script", f"<script>{helper}</script><script", 1)


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
