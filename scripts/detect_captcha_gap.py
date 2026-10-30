"""Detect a Yidun-style jigsaw gap from two rendered image assets.

This helper is intentionally stateless. It reads the public background and
piece images, estimates the horizontal gap offset, and optionally writes an
annotated debug image.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def is_outline_pixel(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    high = max(r, g, b)
    low = min(r, g, b)
    return high >= 160 and high - low <= 48


def piece_metrics(piece_path: Path) -> tuple[int, int]:
    image = Image.open(piece_path).convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("piece image has no visible pixels")
    return bbox[0], bbox[2] - bbox[0]


def piece_boundary(piece_path: Path) -> list[tuple[int, int]]:
    image = Image.open(piece_path).convert("RGBA")
    alpha = image.getchannel("A")
    width, height = image.size
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("piece image has no visible pixels")
    x0, y0, x1, y1 = bbox
    visible = lambda x, y: (
        0 <= x < width
        and 0 <= y < height
        and alpha.getpixel((x, y)) >= 48
    )
    points: list[tuple[int, int]] = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if not visible(x, y):
                continue
            if any(
                not visible(x + dx, y + dy)
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1))
            ):
                points.append((x, y))
    if len(points) < 30:
        raise ValueError("piece boundary is too small")
    return points


def interior_samples(piece_path: Path, step: int = 3) -> list[tuple[int, int, float]]:
    image = Image.open(piece_path).convert("RGBA")
    alpha = image.getchannel("A")
    samples: list[tuple[int, int, float]] = []
    for y in range(0, image.height, step):
        for x in range(0, image.width, step):
            if alpha.getpixel((x, y)) < 220:
                continue
            r, g, b, _ = image.getpixel((x, y))
            luminance = 0.299 * r + 0.587 * g + 0.114 * b
            samples.append((x, y, luminance))
    if len(samples) < 50:
        raise ValueError("piece has too few opaque samples")
    return samples


def correlation(left: list[float], right: list[float]) -> float:
    mean_left = sum(left) / len(left)
    mean_right = sum(right) / len(right)
    numerator = sum(
        (a - mean_left) * (b - mean_right)
        for a, b in zip(left, right)
    )
    left_energy = sum((a - mean_left) ** 2 for a in left)
    right_energy = sum((b - mean_right) ** 2 for b in right)
    denominator = math.sqrt(left_energy * right_energy)
    return numerator / denominator if denominator else 0.0


def detect(background_path: Path, piece_path: Path, display_width: float) -> dict:
    background = Image.open(background_path).convert("RGB")
    width, height = background.size
    piece_left, piece_width = piece_metrics(piece_path)
    boundary = piece_boundary(piece_path)
    samples = interior_samples(piece_path)
    sample_luminance = [sample[2] for sample in samples]
    if piece_width <= 10 or piece_width >= width * 0.45:
        raise ValueError(f"unexpected piece width: {piece_width}px for {width}px background")

    search_start = int(width * 0.10)
    search_end = width - piece_width - int(width * 0.02)
    candidates: list[dict] = []
    for displacement in range(search_start, max(search_start, search_end)):
        background_luminance = []
        for x, y, _ in samples:
            r, g, b = background.getpixel((displacement + x, y))
            background_luminance.append(0.299 * r + 0.587 * g + 0.114 * b)
        pixel_correlation = correlation(sample_luminance, background_luminance)
        boundary_hits = sum(
            is_outline_pixel(background.getpixel((displacement + x, y)))
            for x, y in boundary
        )
        boundary_score = boundary_hits / len(boundary)
        score = 0.85 * max(0.0, pixel_correlation) + 0.15 * boundary_score
        candidates.append({
            "displacement": displacement,
            "gap_left_px": displacement + piece_left,
            "gap_right_px": displacement + piece_left + piece_width,
            "score": score,
            "correlation": pixel_correlation,
            "boundary_score": boundary_score,
        })

    candidates.sort(key=lambda item: item["score"], reverse=True)
    if not candidates:
        raise ValueError("no gap candidates")
    best = candidates[0]
    runner_up = next(
        (
            item for item in candidates[1:]
            if abs(item["displacement"] - best["displacement"]) > piece_width / 2
        ),
        {"score": 0.0, "displacement": 0},
    )

    scale = display_width / width
    distance_css = best["displacement"] * scale
    # The Yidun control usually exposes a 40px handle; stop short of the edge.
    max_distance = display_width - 40
    distance_css = max(0.0, min(distance_css, max_distance))

    separation = best["score"] - float(runner_up.get("score", 0.0))
    confidence = clamp(
        int(best["correlation"] * 80 + separation * 40),
        0,
        99,
    )
    return {
        "distance_css": round(distance_css, 1),
        "displacement_px": best["displacement"],
        "gap_left_px": best["gap_left_px"],
        "gap_right_px": best["gap_right_px"],
        "piece_left_px": piece_left,
        "piece_width_px": piece_width,
        "boundary_points": len(boundary),
        "sample_count": len(samples),
        "background_px": [width, height],
        "display_width_css": display_width,
        "scale": round(scale, 5),
        "confidence": confidence,
        "score": round(best["score"], 4),
        "correlation": round(best["correlation"], 4),
        "boundary_score": round(best["boundary_score"], 4),
        "runner_up_score": round(float(runner_up.get("score", 0.0)), 4),
    }


def annotate(
    background_path: Path,
    output_path: Path,
    gap_left: int,
    gap_right: int,
) -> None:
    image = Image.open(background_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.rectangle(
        (gap_left, 0, gap_right, image.height - 1),
        outline=(255, 0, 0),
        width=3,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--background", required=True)
    parser.add_argument("--piece", required=True)
    parser.add_argument("--display-width", type=float, required=True)
    parser.add_argument("--annotated")
    args = parser.parse_args()

    background_path = Path(args.background).resolve()
    piece_path = Path(args.piece).resolve()
    result = detect(background_path, piece_path, args.display_width)
    if args.annotated:
        annotate(
            background_path,
            Path(args.annotated).resolve(),
            result["gap_left_px"],
            result["gap_right_px"],
        )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
