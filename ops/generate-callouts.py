"""Render local English card callouts using installed macOS voices; no API calls."""
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'assets' / 'voices'
VOICES = {'male': 'Daniel', 'female': 'Samantha'}
RANKS = {'A': ('ace', 'aces'), 'K': ('king', 'kings'), 'Q': ('queen', 'queens')}
COUNTS = {1: 'One', 2: 'Two', 3: 'Three'}
records = []
for gender, voice in VOICES.items():
    folder = ROOT / gender
    folder.mkdir(parents=True, exist_ok=True)
    for rank, forms in RANKS.items():
        for count, word in COUNTS.items():
            phrase = f'{word} {forms[0 if count == 1 else 1]}.'
            output = folder / f'{rank.lower()}-{count}.wav'
            with tempfile.TemporaryDirectory(prefix='liars-callout-') as tmp:
                source = Path(tmp) / 'voice.aiff'
                subprocess.run(['/usr/bin/say', '-v', voice, '-r', '170', '-o', str(source), phrase], check=True)
                subprocess.run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16', str(source), str(output)], check=True)
            records.append({'file': str(output.relative_to(ROOT)), 'gender': gender, 'voice': voice, 'phrase': phrase, 'bytes': output.stat().st_size})
(ROOT / 'manifest.json').write_text(json.dumps({'source': 'Local macOS speech synthesis; not Steam audio', 'clips': records}, indent=2) + '\n')
print(json.dumps({'generatedClips': len(records), 'totalBytes': sum(x['bytes'] for x in records)}))
