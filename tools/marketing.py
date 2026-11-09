#!/usr/bin/env python3
"""Turn a showcase shot run into the install page's pictures (docs/img), its link preview (og.png)
and its tab icon (favicon-32.png).

  node test/shots.mjs dist/dopas-discord-purifier.user.js test/out/shots 2 --showcase
  python3 tools/marketing.py test/out/shots [outDir]     (outDir: somewhere other than docs/img, to look first)

Needs Python 3, Pillow and the Inter font (found with fc-match, or on Windows in INTER_DIR or the font folders). Shots taken at any pace but the
shipped one are refused, so no picture promises a speed the purifier doesn't have; every picture
carries the pace it was taken at, and test/site.mjs checks it against src/main.js.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, PngImagePlugin

ROOT = Path(__file__).resolve().parent.parent
# The hero picture's size; docs/index.html gives its <img> the same width and height.
HERO = (1100, 1000)


def font(style, size):
    # Without fontconfig (Windows), look for Inter-<Style>.ttf in INTER_DIR or the Windows font folders.
    try:
        found = subprocess.run(['fc-match', '-f', '%{file}', f'Inter:{style}'], capture_output=True, text=True, check=True).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        dirs = [os.environ.get('INTER_DIR'), Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft/Windows/Fonts', 'C:/Windows/Fonts']
        files = [Path(d) / f'Inter-{style.capitalize()}.ttf' for d in dirs if d]
        found = next((str(f) for f in files if f.is_file()), '')
    if 'Inter' not in Path(found).name:
        sys.exit(f'Inter {style} is not installed (looked for {found or "it and found nothing"}; set INTER_DIR to a folder of Inter-*.ttf)')
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


def rounded(im, radius):
    """im as RGBA with its corners cut round (anti-aliased), the way the window draws them."""
    big = Image.new('L', (im.width * 4, im.height * 4), 0)
    # One device pixel in from the edge, so none of the mock Discord's grey shows at the corners.
    ImageDraw.Draw(big).rounded_rectangle((4, 4, big.width - 5, big.height - 5), radius * 4, fill=255)
    out = im.convert('RGBA')
    out.putalpha(big.resize(im.size, Image.LANCZOS))
    return out


def lift(size, box, radius, dpr):
    """The panel's --lift shadow (src/styles.css) under a window at box, as an RGBA layer."""
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    for dy, spread, blur, alpha in ((32, -24, 64, .75), (12, -12, 24, .5), (0, 1, 0, .42)):
        mask = Image.new('L', size, 0)
        x0, y0, x1, y1 = box
        grow = spread * dpr
        ImageDraw.Draw(mask).rounded_rectangle((x0 - grow, y0 + dy * dpr - grow, x1 + grow, y1 + dy * dpr + grow), radius + max(grow, 0), fill=round(255 * alpha))
        if blur:
            mask = mask.filter(ImageFilter.GaussianBlur(blur * dpr / 2))
        layer = Image.alpha_composite(layer, Image.merge('RGBA', (*Image.new('RGB', size, (0, 0, 0)).split(), mask)))
    return layer


def main(shots, img):
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
        im.save(img / out, 'WEBP', quality=86, method=6, xmp=xmp)
        print(img / out, im.size)

    webp('00-welcome', 'welcome.webp', 720)
    webp('02-scanned', 'scanned.webp', 720)
    webp('08-done-settled', 'done.webp', 720)
    webp('11-batch-scanned', 'batch.webp', 720)
    webp('15-immune', 'immune.webp', 720)
    webp('04-confirm-holding', 'confirm.webp', 800, crop=(.34, .24, .66, .76))

    panels = json.loads((shots / 'panels.json').read_text('utf8'))
    dpr = panels['dpr']

    # The hero picture: the panel mid-purge lifted out of the mock Discord, in front of its log window,
    # each with its own corners and shadow on a see-through ground, so it floats on the page.
    name = '05-purging-logs'
    shot = Image.open(shots / f'{name}.png').convert('RGB')
    term = rounded(shot.crop(panels['terms'][name]), panels['radius']['term'] * dpr)
    panel = rounded(shot.crop(panels['boxes'][name]), panels['radius']['panel'] * dpr)
    # The panel overlaps the log's right edge (its cut-off lines) and sits lower, so the log's title
    # bar and window buttons stay in view above it.
    overlap, drop, pad, below = 96 * dpr, 56 * dpr, 40 * dpr, 72 * dpr
    tx, ty = pad, pad
    px, py = tx + term.width - overlap, ty + drop
    size = (px + panel.width + pad, max(ty + term.height, py + panel.height) + below)
    hero = Image.new('RGBA', size, (0, 0, 0, 0))
    for im, x, y, radius in ((term, tx, ty, panels['radius']['term']), (panel, px, py, panels['radius']['panel'])):
        hero = Image.alpha_composite(hero, lift(size, (x, y, x + im.width, y + im.height), radius * dpr, dpr))
        hero.alpha_composite(im, (x, y))
    scale = min(HERO[0] / hero.width, HERO[1] / hero.height)
    hero = hero.resize((round(hero.width * scale), round(hero.height * scale)), Image.LANCZOS)
    framed = Image.new('RGBA', HERO, (0, 0, 0, 0))
    framed.alpha_composite(hero, ((HERO[0] - hero.width) // 2, (HERO[1] - hero.height) // 2))
    framed.save(img / 'purging.webp', 'WEBP', quality=88, alpha_quality=90, method=6, xmp=xmp)
    print(img / 'purging.webp', framed.size)

    # Social card for Discord / Twitter embeds: brand on the left, the scanned panel (with its honest ETA) on the right.
    W, H = 1200, 630
    og = Image.new('RGB', (W, H), (21, 11, 17))
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-200, -350, 900, 450), fill=(120, 30, 70))
    og = Image.blend(og, glow.filter(ImageFilter.GaussianBlur(160)), 0.55)
    # Lift the panel out of the mock Discord behind it: its own rounded corners, a soft shadow, the card's glow.
    panel = Image.open(shots / '02-scanned.png').convert('RGB').crop(panels['boxes']['02-scanned'])
    ph = 540
    scale = ph / panel.height
    panel = panel.resize((round(panel.width * scale), ph), Image.LANCZOS)
    radius = round(panels['radius']['panel'] * dpr * scale)
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
    draw.text((72, 520), 'Free  ·  runs in your browser  ·  only your messages', font=font('medium', 24), fill=(160, 131, 147))
    info = PngImagePlugin.PngInfo()
    info.add_text('Description', stamp)
    og.save(img / 'og.png', 'PNG', optimize=True, pnginfo=info)
    print(img / 'og.png', og.size)

    # The tab icon: Dopa's face (glasses and all), which still reads at 16 px where the flames don't.
    face = Image.open(ROOT / 'assets/emote-512.png').convert('RGB')
    w, h = face.size
    face = face.crop((int(w * .10), int(h * .16), int(w * .80), int(h * .86))).resize((128, 128), Image.LANCZOS)
    icon = rounded(face, round(128 * .22)).resize((32, 32), Image.LANCZOS)
    icon.save(img / 'favicon-32.png', 'PNG', optimize=True)
    print(img / 'favicon-32.png', icon.size)


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    out = Path(sys.argv[2]) if len(sys.argv) == 3 else ROOT / 'docs' / 'img'
    out.mkdir(parents=True, exist_ok=True)
    main(Path(sys.argv[1]), out)
