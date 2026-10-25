#!/usr/bin/env python3
"""Turn a showcase shot run into the install page's pictures (docs/img) and its link preview (og.png).

  node test/shots.mjs dist/dopas-discord-purifier.user.js test/out/shots 2 --showcase
  python3 tools/marketing.py test/out/shots

Needs Python 3, Pillow and the Inter font (found with fc-match). Shots taken at any pace but the
shipped one are refused, so no picture promises a speed the purifier doesn't have; every picture
carries the pace it was taken at, and test/site.mjs checks it against src/main.js.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, PngImagePlugin

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / 'docs' / 'img'


def font(style, size):
    found = subprocess.run(['fc-match', '-f', '%{file}', f'Inter:{style}'], capture_output=True, text=True, check=True).stdout
    if 'Inter' not in Path(found).name:
        sys.exit(f'Inter {style} is not installed (fc-match offered {found or "nothing"})')
    return ImageFont.truetype(found, size)


def shipped_pace():
    # Each key on its own, so a new TIMING field (or a reorder) can't make this miss.
    block = re.search(r'const TIMING = \{([^}]*)\}', (ROOT / 'src/main.js').read_text('utf8'))
    if not block:
        sys.exit('src/main.js has no const TIMING block')
    pace = {}
    for key in ('deleteDelayMs', 'searchDelayMs'):
        found = re.search(rf'\b{key}:\s*(\d+)', block[1])
        if not found:
            sys.exit(f'src/main.js: no {key} in const TIMING')
        pace[key] = int(found[1])
    return pace


def main(shots):
    pace = shipped_pace()
    taken = json.loads((shots / 'pace.json').read_text('utf8'))
    if taken != pace:
        sys.exit(f'{shots} was shot at {taken}, but the purifier ships {pace}. Re-run test/shots.mjs on the built userscript.')
    stamp = f'dopa-pace: deleteDelayMs={pace["deleteDelayMs"]} searchDelayMs={pace["searchDelayMs"]}'
    xmp = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
           '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
           f'<dc:description>{stamp}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>').encode()

    def webp(name, out, width, crop=None):
        im = Image.open(shots / f'{name}.png').convert('RGB')
        if crop:
            w, h = im.size
            im = im.crop((int(w * crop[0]), int(h * crop[1]), int(w * crop[2]), int(h * crop[3])))
        if im.width > width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        im.save(IMG / out, 'WEBP', quality=86, method=6, xmp=xmp)
        print(f'docs/img/{out}', im.size)

    webp('00-welcome', 'welcome.webp', 720)
    webp('02-scanned', 'scanned.webp', 720)
    webp('05-purging-logs', 'purging.webp', 1400)
    webp('08-done-settled', 'done.webp', 720)
    webp('11-batch-scanned', 'batch.webp', 720)
    webp('15-immune', 'immune.webp', 720)
    webp('04-confirm-holding', 'confirm.webp', 800, crop=(.34, .24, .66, .76))

    # Social card for Discord / Twitter embeds: brand on the left, the scanned panel (with its honest ETA) on the right.
    W, H = 1200, 630
    og = Image.new('RGB', (W, H), (21, 11, 17))
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-200, -350, 900, 450), fill=(120, 30, 70))
    og = Image.blend(og, glow.filter(ImageFilter.GaussianBlur(160)), 0.55)
    # Lift the panel out of the mock Discord behind it: its own rounded corners, a soft shadow, the card's glow.
    panels = json.loads((shots / 'panels.json').read_text('utf8'))
    panel = Image.open(shots / '02-scanned.png').convert('RGB').crop(panels['boxes']['02-scanned'])
    ph = 540
    scale = ph / panel.height
    panel = panel.resize((round(panel.width * scale), ph), Image.LANCZOS)
    radius = round(20 * panels['dpr'] * scale)  # --r-panel in src/styles.css
    x, y = W - panel.width - 80, (H - ph) // 2
    shadow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 18, x + panel.width, y + ph + 18), radius, fill=170)
    og = Image.composite(Image.new('RGB', (W, H), (6, 2, 5)), og, shadow.filter(ImageFilter.GaussianBlur(24)))
    mask = Image.new('L', panel.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, panel.width - 1, ph - 1), radius, fill=255)
    og.paste(panel, (x, y), mask)
    emote = Image.open(ROOT / 'assets/emote-512.png').convert('RGB').resize((120, 120), Image.LANCZOS)
    mask = Image.new('L', (120, 120), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 119, 119), 34, fill=255)
    og.paste(emote, (72, 92), mask)
    draw = ImageDraw.Draw(og)
    draw.text((72, 240), "Dopa's Discord", font=font('bold', 64), fill=(248, 235, 241))
    draw.text((72, 312), 'Purifier', font=font('bold', 64), fill=(255, 160, 194))
    draw.text((72, 410), 'Wipe your own messages from any', font=font('medium', 30), fill=(207, 179, 193))
    draw.text((72, 450), 'DM, group or server — in a few clicks~', font=font('medium', 30), fill=(207, 179, 193))
    draw.text((72, 520), 'Free  ·  runs in your browser  ·  open source', font=font('medium', 24), fill=(160, 131, 147))
    info = PngImagePlugin.PngInfo()
    info.add_text('Description', stamp)
    og.save(IMG / 'og.png', 'PNG', optimize=True, pnginfo=info)
    print('docs/img/og.png', og.size)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
