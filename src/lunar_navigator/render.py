"""Conversão de matrizes NumPy em imagens PNG (bytes / base64) para a web e relatórios."""

import base64
import io

import numpy as np
from matplotlib import colormaps
from PIL import Image

PSR_COLOR = (64, 200, 255)  # ciano: sombra permanente (gelo)


def hillshade(h: np.ndarray, pixel: float, azimuth_deg: float = 315, altitude_deg: float = 45) -> np.ndarray:
    """Relevo sombreado clássico (0..1), apenas para visualização."""
    dy, dx = np.gradient(h.astype(np.float64), pixel)
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az, alt = np.radians(azimuth_deg), np.radians(altitude_deg)
    return np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)


def colorize(values: np.ndarray, cmap: str, vmin: float, vmax: float) -> np.ndarray:
    norm = np.clip((values - vmin) / (vmax - vmin), 0, 1)
    return (colormaps[cmap](norm)[..., :3] * 255).astype(np.uint8)


def basemap_rgb(heights: np.ndarray, pixel: float) -> np.ndarray:
    """Hillshade em cinza levemente tingido pela altitude."""
    shade = hillshade(heights, pixel)
    tint = colorize(heights, "gist_earth", np.percentile(heights, 1), np.percentile(heights, 99))
    gray = (shade[..., None] * 255).astype(np.float32)
    return (0.75 * gray + 0.25 * tint).astype(np.uint8)


def overlay_mask(rgb: np.ndarray, mask: np.ndarray, color=PSR_COLOR, alpha: float = 0.85) -> np.ndarray:
    out = rgb.astype(np.float32)
    out[mask] = (1 - alpha) * out[mask] + alpha * np.array(color, np.float32)
    return out.astype(np.uint8)


def png_bytes(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def png_data_uri(rgb: np.ndarray) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes(rgb)).decode("ascii")
