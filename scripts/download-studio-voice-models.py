"""Download only the two published VoiceFixer weights; verify their upstream Zenodo checksums."""
import hashlib
import os
from pathlib import Path
import urllib.request

CACHE = Path.home() / '.cache' / 'voicefixer'
MODELS = [
    ('analysis_module/checkpoints/vf.ckpt', 'https://zenodo.org/records/5600188/files/vf.ckpt?download=1', '1f479dabb9fa5724de5e20f2164cbc7a'),
    ('synthesis_module/44100/model.ckpt-1490000_trimed.pt', 'https://zenodo.org/records/5469951/files/model.ckpt-1490000_trimed.pt?download=1', 'ac6de16561dd6042daf8bb3a806dc818'),
]

def checksum(path):
    value = hashlib.md5()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()

for relative, url, expected in MODELS:
    target = CACHE / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and checksum(target) == expected:
        print('Verified:', target.name, flush=True)
        continue
    temporary = target.with_suffix(target.suffix + '.download')
    print('Downloading:', target.name, flush=True)
    with urllib.request.urlopen(url, timeout=120) as source, temporary.open('wb') as output:
        while block := source.read(1024 * 1024):
            output.write(block)
    if checksum(temporary) != expected:
        temporary.unlink(missing_ok=True)
        raise RuntimeError('Model checksum mismatch: ' + target.name)
    os.replace(temporary, target)
    print('Verified:', target.name, flush=True)
