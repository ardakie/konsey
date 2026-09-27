"""
Uygulama simgelerini build/icon-source.jpg'den uretir (Pillow gerekir).

  build/icon.png   1024 px, macOS izgarasi: 824 px yuvarlak kare + saydam kenar
  build/icon.icns  macOS
  build/icon.ico   Windows (16-256 px), kenar boslugu daha az

Uretilen dosyalar depoya eklenir; paketleme bu betigi calistirmaz.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'build' / 'icon-source.jpg'


def rounded(size: int, inset: int, radius_ratio: float) -> Image.Image:
    """Kaynak gorseli size x size tuvalde, inset kenar boslugu birakan yuvarlak kareye yerlestirir."""
    inner = size - 2 * inset
    art = Image.open(SRC).convert('RGBA').resize((inner * 4, inner * 4), Image.LANCZOS)
    mask = Image.new('L', (inner * 4, inner * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, inner * 4 - 1, inner * 4 - 1), radius=int(inner * 4 * radius_ratio), fill=255)
    art.putalpha(mask)
    art = art.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art, (inset, inset))
    return canvas


mac = rounded(1024, 100, 0.2237)
mac.save(ROOT / 'build' / 'icon.png')
mac.save(ROOT / 'build' / 'icon.icns')

win = rounded(256, 8, 0.2)
win.save(ROOT / 'build' / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

print('ok')
