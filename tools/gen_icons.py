"""生成扩展图标（纯标准库，无第三方依赖）。
深色圆角底 + 亮蓝 X 字形，风格对齐 X 站点深色主题。
"""
import math
import struct
import zlib
import os

BG = (11, 15, 20)          # #0B0F14 深色底
ACCENT = (29, 155, 240)    # #1D9BF0 X 蓝
ACCENT_2 = (231, 233, 234) # #E7E9EA 近白（X 交叉处高光）


def rounded_alpha(x, y, size, radius):
    """返回圆角矩形内部判定：1.0 内部，0.0 外部（含 1px 抗锯齿）。"""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    d = math.hypot(x - cx, y - cy)
    if d <= radius - 1:
        return 1.0
    if d >= radius:
        return 0.0
    return radius - d


def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def mix(c1, c2, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def render(size):
    radius = size * 0.22
    stroke = max(1.6, size * 0.135)
    pad = size * 0.24
    p1 = (pad, pad)
    p2 = (size - pad, size - pad)
    q1 = (size - pad, pad)
    q2 = (pad, size - pad)

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            a = rounded_alpha(px, py, size, radius)
            if a <= 0:
                row += bytes((0, 0, 0, 0))
                continue

            base = BG
            d = min(
                dist_to_segment(px, py, p1[0], p1[1], p2[0], p2[1]),
                dist_to_segment(px, py, q1[0], q1[1], q2[0], q2[1]),
            )
            if d <= stroke / 2 - 0.8:
                base = ACCENT
            elif d <= stroke / 2 + 0.8:
                t = (d - (stroke / 2 - 0.8)) / 1.6
                base = mix(ACCENT, BG, t)
            else:
                # 中心交叉点一点高光
                center_d = math.hypot(px - size / 2, py - size / 2)
                if center_d < size * 0.055:
                    base = mix(ACCENT_2, BG, center_d / (size * 0.055))

            row += bytes((base[0], base[1], base[2], int(round(a * 255))))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = bytearray()
    for r in rows:
        raw.append(0)  # filter type 0
        raw += r

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(project_root, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 48, 128):
        rows = render(s)
        p = os.path.join(out_dir, f"icon{s}.png")
        write_png(p, s, rows)
        print("生成:", p, os.path.getsize(p), "bytes")
