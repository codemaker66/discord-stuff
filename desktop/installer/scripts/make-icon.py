"""Builds the 1024x1024 app icon: the emote art in a rounded square on a transparent canvas.

Usage (from desktop/installer):
    python scripts/make-icon.py ../../assets/emote-512.png E:/somewhere/app-icon-1024.png
    npx tauri icon E:/somewhere/app-icon-1024.png -o src-tauri/icons
then delete the android/, ios/, Square*Logo.png, StoreLogo.png and icon.icns outputs
(this is a Windows-only app). emote-512.png is the same art as assets/icon.webp at 5x the size.
"""
import sys
from PIL import Image, ImageDraw, ImageFilter

src, out = sys.argv[1], sys.argv[2]
SIZE = 1024
MARGIN = 56            # transparent breathing room around the tile
RADIUS = 210           # corner radius of the tile (about 23%)
SS = 4                 # supersampling for smooth edges

art = Image.open(src).convert("RGBA")
tile = SIZE - 2 * MARGIN
art = art.resize((tile, tile), Image.LANCZOS)

mask_big = Image.new("L", (tile * SS, tile * SS), 0)
ImageDraw.Draw(mask_big).rounded_rectangle((0, 0, tile * SS - 1, tile * SS - 1), RADIUS * SS, fill=255)
mask = mask_big.resize((tile, tile), Image.LANCZOS)

canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
# soft drop shadow so the tile reads on light and dark backgrounds
shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
sh = Image.new("RGBA", (tile, tile), (0, 0, 0, 110))
shadow.paste(sh, (MARGIN, MARGIN + 14), mask)
shadow = shadow.filter(ImageFilter.GaussianBlur(18))
canvas = Image.alpha_composite(canvas, shadow)
layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
layer.paste(art, (MARGIN, MARGIN), mask)
canvas = Image.alpha_composite(canvas, layer)
# thin inner edge highlight
edge_big = Image.new("L", (tile * SS, tile * SS), 0)
d = ImageDraw.Draw(edge_big)
d.rounded_rectangle((0, 0, tile * SS - 1, tile * SS - 1), RADIUS * SS, outline=255, width=3 * SS)
edge = edge_big.resize((tile, tile), Image.LANCZOS)
hl = Image.new("RGBA", (tile, tile), (255, 255, 255, 46))
hl_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
hl_layer.paste(hl, (MARGIN, MARGIN), edge)
canvas = Image.alpha_composite(canvas, hl_layer)
canvas.save(out)
print(out, canvas.size, canvas.mode)
