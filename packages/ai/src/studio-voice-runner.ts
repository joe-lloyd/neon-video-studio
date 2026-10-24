/** Shipped with the app and written beside the isolated Python runtime before execution. */
export const STUDIO_VOICE_RUNNER = String.raw`
import argparse
import importlib.util
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--input')
parser.add_argument('--output')
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
cache = Path.home() / '.cache' / 'voicefixer'
weights = [
    (cache / 'analysis_module/checkpoints/vf.ckpt', 489307071),
    (cache / 'synthesis_module/44100/model.ckpt-1490000_trimed.pt', 135613039),
]
if importlib.util.find_spec('voicefixer') is None or any(not p.exists() or p.stat().st_size != size for p, size in weights):
    raise RuntimeError('Local Studio Voice model is not installed completely. Run scripts/install-studio-voice.ps1.')
import torch
if args.check:
    print(json.dumps({'available': True, 'provider': 'voicefixer', 'device': 'cuda' if torch.cuda.is_available() else 'cpu', 'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))
    sys.exit(0)
if not args.input or not args.output:
    parser.error('--input and --output are required')
import numpy as np
import soundfile as sf
from voicefixer import VoiceFixer
print('Loading local VoiceFixer model...', flush=True)
model = VoiceFixer()
audio, sr = sf.read(args.input, dtype='float32')
if sr != 44100 or audio.ndim != 1:
    raise RuntimeError('Studio Voice requires prepared 44.1 kHz mono audio')
cuda = torch.cuda.is_available()
print('Restoring on ' + (torch.cuda.get_device_name(0) if cuda else 'CPU'), flush=True)
# Bound GPU memory and report progress. Context on each side avoids hard chunk boundaries.
chunk = 44100 * 20
context = 44100 // 4
restored = np.zeros(len(audio), dtype=np.float32)
weight_sum = np.zeros(len(audio), dtype=np.float32)
for index, start in enumerate(range(0, len(audio), chunk)):
    end = min(len(audio), start + chunk)
    left = max(0, start - context)
    right = min(len(audio), end + context)
    result = np.asarray(model.restore_inmem(audio[left:right], cuda=cuda, mode=0)).reshape(-1)
    expected = right - left
    if abs(len(result) - expected) > 4410:
        raise RuntimeError('The model changed audio timing unexpectedly')
    result = np.pad(result, (0, max(0, expected-len(result))))[:expected]
    weight = np.ones(expected, dtype=np.float32)
    if left < start:
        weight[:start-left] = np.linspace(0, 1, start-left, endpoint=False)
    if end < right:
        weight[end-left:] = np.linspace(1, 0, right-end, endpoint=False)
    restored[left:right] += result * weight
    weight_sum[left:right] += weight
    print('NEON_PROGRESS ' + str(end / len(audio)), flush=True)
restored /= np.maximum(weight_sum, 1e-8)
sf.write(args.output, restored, 44100, subtype='PCM_24')
print('Local restoration complete.', flush=True)
`;
