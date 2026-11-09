#!/usr/bin/env python3
"""The share card for the Discord app installer: docs/img/share-desktop.png, 1200x630.

  python tools/share_card.py [out.png]

It sits at the top of every desktop release's notes (desktop/RELEASE_NOTES.md) and is the picture to send
a friend with the download link. Same family as the page's link preview (tools/marketing.py draws og.png):
the wine ground and rose glow, Dopa on the left, the purifier at work on the right, here wearing a
Discord-app window and a download button. Needs Pillow and the Inter font (fc-match, or INTER_DIR on Windows).
The panel picture shows an ETA, so the card carries the shipped pace the way the page's pictures do.
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marketing import ROOT, font, shipped_pace  # noqa: E402

W, H = 1200, 630
S = 2  # drawn at twice the size, then scaled down, so every curve and edge is smooth

WINE = (21, 11, 17)
T1 = (248, 235, 241)
T2 = (207, 179, 193)
T3 = (160, 131, 147)
ROSE_300 = (255, 160, 194)
ROSE_INK = (42, 7, 22)


def s(v):
    return round(v * S)


def shape(size, draw_fn, blur=0):
    mask = Image.new('L', size, 0)
    draw_fn(ImageDraw.Draw(mask))
    return mask.filter(ImageFilter.GaussianBlur(blur)) if blur else mask


def tint(size, color, mask, alpha=255):
    layer = Image.new('RGBA', size, color + (0,))
    layer.putalpha(mask if alpha == 255 else ImageChops.multiply(mask, Image.new('L', size, alpha)))
    return layer


def vertical_gradient(size, top, bottom):
    w, h = size
    col = Image.new('RGB', (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        col.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return col.resize(size)


def discord_window(size, box, radius):
    """A dark Discord-app window with Windows' caption buttons, a server rail and quiet chat lines."""
    x0, y0, x1, y1 = box
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius, fill=(30, 31, 34, 255))
    d.rounded_rectangle((x0, y0, x1, y0 + s(40)), radius, fill=(23, 24, 27, 255))
    d.rectangle((x0, y0 + s(20), x1, y0 + s(40)), fill=(23, 24, 27, 255))
    d.text((x0 + s(20), y0 + s(20)), 'Discord', font=font('semibold', s(14)), fill=(181, 186, 193, 255), anchor='lm')
    grey = (181, 186, 193, 255)
    cy = y0 + s(20)
    for i, glyph in enumerate(('min', 'max', 'close')):
        cx = min(x1, size[0]) - s(36) - s(46) * (2 - i)  # from the card's edge when the window runs off it
        if glyph == 'min':
            d.line((cx - s(6), cy, cx + s(6), cy), fill=grey, width=s(1.4))
        elif glyph == 'max':
            d.rectangle((cx - s(5.5), cy - s(5.5), cx + s(5.5), cy + s(5.5)), outline=grey, width=s(1.4))
        else:
            d.line((cx - s(6), cy - s(6), cx + s(6), cy + s(6)), fill=grey, width=s(1.4))
            d.line((cx - s(6), cy + s(6), cx + s(6), cy - s(6)), fill=grey, width=s(1.4))
    for i in range(7):
        y = y0 + s(58) + i * s(58)
        d.rounded_rectangle((x0 + s(14), y, x0 + s(58), y + s(44)), s(15), fill=(255, 122, 169, 255) if i == 0 else (49, 51, 56, 255))
    for i in range(8):
        y = y0 + s(70) + i * s(58)
        d.ellipse((x0 + s(84), y, x0 + s(116), y + s(32)), fill=(49, 51, 56, 255))
        d.rounded_rectangle((x0 + s(128), y + s(4), x0 + s(128) + s(70 + (i * 37) % 60), y + s(13)), s(4), fill=(62, 64, 70, 255))
        d.rounded_rectangle((x0 + s(128), y + s(19), x0 + s(128) + s(140 + (i * 53) % 170), y + s(28)), s(4), fill=(44, 46, 50, 255))
    d.rounded_rectangle(box, radius, outline=(255, 208, 226, 46), width=s(1.5))
    return layer


def main(out):
    pace = shipped_pace()
    stamp = f'dopa-pace: deleteDelayMs={pace["deleteDelayMs"]} searchDelayMs={pace["searchDelayMs"]}'
    size = (s(W), s(H))

    # The ground: the page's wine, a rose glow behind the words, a deeper one behind the window.
    card = Image.new('RGBA', size, WINE + (255,))
    card.alpha_composite(tint(size, (150, 38, 88), shape(size, lambda d: d.ellipse((s(-260), s(-360), s(820), s(430)), fill=150), s(150))))
    card.alpha_composite(tint(size, (110, 26, 66), shape(size, lambda d: d.ellipse((s(560), s(60), s(1380), s(820)), fill=170), s(170))))
    card.alpha_composite(tint(size, (255, 122, 169), shape(size, lambda d: d.ellipse((s(700), s(140), s(1160), s(560)), fill=60), s(110))))

    # The Discord app window, lifted off the card, with the purifier at work inside it.
    box = (s(628), s(86), s(1236), s(660))
    radius = s(18)
    card.alpha_composite(tint(size, (4, 1, 3), shape(size, lambda d: d.rounded_rectangle((box[0], box[1] + s(26), box[2], box[3] + s(26)), radius, fill=200), s(30))))
    card.alpha_composite(discord_window(size, box, radius))
    clip = shape(size, lambda d: d.rounded_rectangle(box, radius, fill=255))
    hero = Image.open(ROOT / 'docs/img/purging.webp').convert('RGBA').crop((60, 30, 1060, 960))
    hh = s(500)
    hero = hero.resize((round(hero.width * hh / hero.height), hh), Image.LANCZOS)
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    layer.alpha_composite(hero, (s(662), s(122)))
    layer.putalpha(ImageChops.multiply(layer.getchannel('A'), clip))
    card.alpha_composite(layer)
    # The window sinks into the card's bottom edge instead of stopping at it.
    fade = Image.new('L', size, 0)
    fade.paste(vertical_gradient((size[0], s(64)), (0, 0, 0), (220, 220, 220)).convert('L'), (0, size[1] - s(64)))
    card.alpha_composite(tint(size, WINE, fade))

    # Left: Dopa, the announcement, the name, one line, and the button it's all about.
    emote = Image.open(ROOT / 'assets/emote-512.png').convert('RGBA').resize((s(96), s(96)), Image.LANCZOS)
    emote.putalpha(shape(emote.size, lambda d: d.rounded_rectangle((0, 0, emote.width - 1, emote.height - 1), s(28), fill=255)))
    ex, ey = s(72), s(70)
    card.alpha_composite(tint(size, (255, 90, 150), shape(size, lambda d: d.rounded_rectangle((ex, ey + s(10), ex + s(96), ey + s(106)), s(28), fill=200), s(16)), 150))
    card.alpha_composite(emote, (ex, ey))
    card.alpha_composite(tint(size, (255, 122, 169), shape(size, lambda d: d.rounded_rectangle((ex - s(1), ey - s(1), ex + s(96), ey + s(96)), s(29), outline=255, width=s(1.5))), 120))

    d = ImageDraw.Draw(card)
    tag_font = font('bold', s(15))
    spaced = ' '.join('NOW IN THE DISCORD APP')
    tw = d.textlength(spaced, font=tag_font)
    px, py = s(190), s(100)
    pill = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(pill).rounded_rectangle((px, py, px + tw + s(46), py + s(36)), s(18), fill=(255, 122, 169, 34), outline=(255, 122, 169, 140), width=s(1.5))
    card.alpha_composite(pill)
    d = ImageDraw.Draw(card)
    d.ellipse((px + s(15), py + s(14), px + s(23), py + s(22)), fill=ROSE_300)
    d.text((px + s(32), py + s(18)), spaced, font=tag_font, fill=ROSE_300, anchor='lm')

    title = font('bold', s(68))
    d.text((s(68), s(196)), "Dopa's Discord", font=title, fill=T1)
    d.text((s(68), s(272)), 'Purifier', font=title, fill=ROSE_300)
    body = font('medium', s(27))
    d.text((s(72), s(380)), 'Wipe your own messages, right inside', font=body, fill=T2)
    d.text((s(72), s(416)), 'the Discord app~ one download ♡', font=body, fill=T2)

    # The button: the page's rose gradient, its edge highlight and its glow.
    bx0, by0, bx1, by1 = s(72), s(484), s(392), s(546)
    card.alpha_composite(tint(size, (255, 90, 150), shape(size, lambda d2: d2.rounded_rectangle((bx0 + s(12), by0 + s(18), bx1 - s(12), by1 + s(14)), s(18), fill=210), s(18)), 170))
    grad = vertical_gradient((bx1 - bx0, by1 - by0), (255, 143, 184), (255, 108, 159)).convert('RGBA')
    grad.putalpha(shape(grad.size, lambda d2: d2.rounded_rectangle((0, 0, grad.width - 1, grad.height - 1), s(18), fill=255)))
    card.alpha_composite(grad, (bx0, by0))
    card.alpha_composite(tint(size, (255, 255, 255), shape(size, lambda d2: d2.rounded_rectangle((bx0, by0, bx1, by1), s(18), outline=255, width=s(1.5))), 90))
    d = ImageDraw.Draw(card)
    gx, gy = bx0 + s(34), (by0 + by1) // 2
    d.line((gx, gy - s(11), gx, gy + s(5)), fill=ROSE_INK, width=s(3))
    d.line((gx - s(7), gy - s(2), gx, gy + s(5), gx + s(7), gy - s(2)), fill=ROSE_INK, width=s(3), joint='curve')
    d.line((gx - s(10), gy + s(12), gx + s(10), gy + s(12)), fill=ROSE_INK, width=s(3))
    d.text((gx + s(24), gy), 'Get it for Windows', font=font('bold', s(24)), fill=ROSE_INK, anchor='lm')
    d.text((bx1 + s(22), gy), 'Free  ·  Windows 10/11', font=font('medium', s(19)), fill=T3, anchor='lm')

    final = card.convert('RGB').resize((W, H), Image.LANCZOS)
    info = PngImagePlugin.PngInfo()
    info.add_text('Description', stamp)
    info.add_text('Title', "Dopa's Discord Purifier: now in the Discord app")
    out.parent.mkdir(parents=True, exist_ok=True)
    final.save(out, 'PNG', optimize=True, pnginfo=info)
    print(out, final.size)


if __name__ == '__main__':
    if len(sys.argv) > 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / 'docs' / 'img' / 'share-desktop.png')
