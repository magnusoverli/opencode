"""ttyd's fixed command. Only an explicit page open/manual retry may create a session."""
import re
import secrets
import signal
import subprocess
import sys


def main(args, session_command="/usr/local/bin/opencode-session.sh"):
    if len(args) != 1 or not (match := re.fullmatch(r"(open|resume)-([0-9a-f]{32})", args[0])):
        return 2
    mode, page = match.groups()
    # Session options vanish with tmux. Limit abandoned tab entries; a slot
    # collision can only refuse recovery, never attach a different tab/session.
    slot = "@ha_resume_" + page[:3]
    owner = page + "-" + secrets.token_hex(8)
    target = "opencode"
    mark = ["set-option", "-t", target, slot, owner]
    if mode == "open":
        command = ["new-session", "-A", "-s", "opencode", session_command, ";", *mark]
    else:
        # Check and attach inside the *same tmux server*. A replaced session
        # has no matching mark. No -A or new-session on this path.
        command = ["-N", "if-shell", "-F", "-t", "=" + target + ":",
                   "#{m:" + page + "-*,#{" + slot + "}}",
                   " ".join(mark) + " ; attach-session -t " + target]

    # ttyd signals the entire PTY process group on transport loss. Leave the
    # mark in that case. A tmux detach or shell exit returns normally and we
    # revoke it before ttyd sends Close. A late cleanup cannot revoke a newer
    # attachment. tmux attaches using the tty on stdin.
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    quiet = subprocess.DEVNULL if mode == "resume" else None
    result = subprocess.run(["tmux", *command], stdout=quiet, stderr=quiet)
    subprocess.run(["tmux", "-N", "if-shell", "-F", "-t", "=" + target + ":",
                    "#{==:#{" + slot + "}," + owner + "}", "set-option -u -t " + target + " " + slot],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # A vanished server/session is an ordinary refusal, not another network
    # failure. A silent, clean resume close returns the page to manual open.
    return 0 if mode == "resume" else result.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
