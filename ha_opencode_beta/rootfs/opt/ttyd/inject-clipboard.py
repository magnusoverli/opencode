#!/usr/bin/env python3
"""Build-time helper: inject local scripts into ttyd's index page.

ttyd serves a single self-contained HTML page (all JS/CSS inlined, compiled
into the binary), so the only way to extend it is to dump the served page and
splice our script in before </body>. Usage:

    inject-clipboard.py <dumped-index.html> <output.html> <script.js> [script.js ...]
"""

import sys


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
