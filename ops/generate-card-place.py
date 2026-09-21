"""Create an original short paper/felt impact sound, with no speech or samples."""
import math
from pathlib import Path
import random
import struct
import wave

rate = 44100
rng = random.Random(921)
samples = []
low = 0.0
previous = 0.0
for i in range(int(rate * 0.23)):
    t = i / rate
    noise = rng.uniform(-1, 1)
    low += 0.24 * (noise - low)
    paper = noise - previous
    previous = noise
    slide = 0.035 * paper * math.sin(math.pi * min(t / 0.045, 1)) ** 2 if t < 0.045 else 0
    sound = slide
    for start, strength in [(0.034, 1.0), (0.047, 0.38)]:
        age = t - start
        if age >= 0:
            attack = min(age / 0.0015, 1)
            sound += strength * attack * (0.52 * low * math.exp(-age / 0.018)
                + 0.09 * paper * math.exp(-age / 0.006)
                + 0.09 * math.sin(2 * math.pi * 170 * age) * math.exp(-age / 0.012))
    samples.append(sound * min((0.23 - t) / 0.02, 1))
scale = 0.7 / max(abs(value) for value in samples)
path = Path(__file__).resolve().parents[1] / 'public/assets/audio/card-place-v1.wav'
path.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(path), 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(rate)
    output.writeframes(b''.join(struct.pack('<h', round(value * scale * 32767)) for value in samples))
print(path)
