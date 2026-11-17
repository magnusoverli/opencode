"""Build-time only installer. Never invoked against the live add-on here."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_package(package, bundle):
    manifest = json.loads((bundle/'manifest.json').read_text())
    # Validate every input before touching any file. Reject symlinks/unknown trees.
    for relative, expected in manifest['baseline'].items():
        target = package/relative
        if target.is_symlink() or not target.is_file() or sha(target) != expected:
            raise RuntimeError('Package baseline mismatch: '+relative)
    for relative, expected in manifest['candidate'].items():
        source = bundle/'candidate/zigporter'/relative
        target = package/relative
        if not source.is_file() or sha(source) != expected:
            raise RuntimeError('Candidate artifact mismatch: '+relative)
        if target.is_symlink() or (relative not in manifest['baseline'] and target.exists()):
            raise RuntimeError('Unexpected existing destination: '+relative)
    marker = package/'jarvis_compat_revision.json'
    if marker.exists():
        raise RuntimeError('Compatibility revision already exists')
    for relative in manifest['candidate']:
        target = package/relative
        target.write_bytes((bundle/'candidate/zigporter'/relative).read_bytes())
        target.chmod(0o644)
    marker.write_text(json.dumps(manifest,indent=2)+'\n')


def main():
    bundle = Path(__file__).resolve().parent
    if importlib.metadata.version("zigporter") != "1.4.2":
        raise RuntimeError("Re-evaluate compatibility patch for new Zigporter release")
    import zigporter
    apply_package(Path(zigporter.__file__).parent, bundle)

if __name__ == "__main__":
    main()
