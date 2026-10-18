# One-time local Studio Voice setup. Run with Python 3.11 installed.
param([string]$Python = 'python', [switch]$Cpu)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.neon-video\tools\studio-voice-runtime'
$ready = Join-Path $root 'ready.json'
if (Test-Path $ready) { Remove-Item $ready }
& $Python -c "import sys; assert sys.version_info[:2] == (3,11), 'Studio Voice setup requires Python 3.11'"
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11 or pass -Python with its full path' }
if (-not (Test-Path (Join-Path $root 'Scripts\python.exe'))) {
  & $Python -m venv $root
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Studio Voice runtime' }
}
$runtimePython = Join-Path $root 'Scripts\python.exe'
$index = if ($Cpu) { 'https://download.pytorch.org/whl/cpu' } else { 'https://download.pytorch.org/whl/cu121' }
& $runtimePython -m pip install --disable-pip-version-check 'torch==2.5.1' 'torchaudio==2.5.1' --index-url $index
if ($LASTEXITCODE -ne 0) { throw 'Could not install PyTorch' }
& $runtimePython -m pip install --disable-pip-version-check 'numpy==1.26.4' 'librosa==0.10.2.post1' 'matplotlib<3.11' progressbar 'torchlibrosa==0.1.0' GitPython PyYAML soundfile
if ($LASTEXITCODE -ne 0) { throw 'Could not install restoration dependencies' }
& $runtimePython -m pip install --disable-pip-version-check --no-deps 'voicefixer==0.1.3'
if ($LASTEXITCODE -ne 0) { throw 'Could not install VoiceFixer' }
& $runtimePython (Join-Path $PSScriptRoot 'download-studio-voice-models.py')
if ($LASTEXITCODE -ne 0) { throw 'Model download or checksum validation failed' }
# Instantiate only after verified downloads, so VoiceFixer never downloads unchecked weights.
& $runtimePython -c "import torch,json,pathlib; from voicefixer import VoiceFixer; model=VoiceFixer(); device='cuda' if torch.cuda.is_available() else 'cpu'; print('Studio Voice ready:',device); pathlib.Path(r'$ready').write_text(json.dumps({'provider':'voicefixer','device':device,'version':'0.1.3'}))"
if ($LASTEXITCODE -ne 0) { throw 'Local model validation failed' }
Write-Host 'Studio Voice installed. In Neon, refresh AI engines.'
