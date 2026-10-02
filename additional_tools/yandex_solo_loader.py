#!/usr/bin/env python3
"""yandex_pano_download.py — скачивает панораму Яндекс.Карт по ссылке в максимальном качестве (JPEG 360°)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import os
import platform
import sys
from dataclasses import dataclass
from io import BytesIO
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs, unquote

import requests
from PIL import Image

try:
    import aiohttp
except ImportError:
    print("Не найден aiohttp. Установите: pip install aiohttp", file=sys.stderr)
    raise

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
}

TILE_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "ru,en;q=0.9",
    "Referer": "https://yandex.ru/maps/",
}

PANO_META_BY_ID_URL = (
    "https://api-maps.yandex.ru/services/panoramas/1.x/"
    "?l={layer}&lang=ru_RU&oid={pano_id}&origin=userAction&provider=streetview"
)
PANO_META_BY_COORDS_URL = (
    "https://api-maps.yandex.ru/services/panoramas/1.x/"
    "?l={layer}&lang=ru_RU&ll={lon},{lat}&origin=userAction&provider=streetview"
)
TILE_URL = "https://pano.maps.yandex.net/{image_id}/{zoom}.{x}.{y}"

log = logging.getLogger("yandex_pano_download")


def setup_logging(log_file: Optional[str]) -> None:
    log.setLevel(logging.DEBUG)
    log.handlers.clear()
    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(console)
    if log_file:
        os.makedirs(os.path.dirname(log_file) or ".", exist_ok=True)
        file_handler = logging.FileHandler(log_file, mode="w", encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        log.addHandler(file_handler)


@dataclass
class PanoLink:
    url: str
    pano_id: Optional[str]
    lon: float
    lat: float


def _parse_pair(value: Optional[str]) -> Optional[Tuple[float, float]]:
    if not value:
        return None
    value = unquote(value)
    parts = value.split(",")
    if len(parts) != 2:
        return None
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None


def parse_pano_url(url: str) -> PanoLink:
    parsed = urlparse(url)
    params = parse_qs(parsed.query)

    def first(key: str) -> Optional[str]:
        v = params.get(key)
        return v[0] if v else None

    pano_id = first("panorama[id]")
    point = _parse_pair(first("panorama[point]")) or _parse_pair(first("ll"))
    if point is None:
        raise ValueError(f"Не удалось найти координаты панорамы в ссылке: {url}")
    lon, lat = point
    return PanoLink(url=url, pano_id=pano_id, lon=lon, lat=lat)


def _fetch_json(url: str) -> Optional[Dict]:
    try:
        resp = requests.get(url, headers=REQUEST_HEADERS, timeout=15)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        log.debug(f"Запрос не удался ({url}): {e}")
        return None


def _extract_pano_meta(data: Dict, zoom: int) -> Optional[Dict]:
    try:
        images = data["data"]["Data"]["Images"]
        image_id = images["imageId"]
        tile_width = images["Tiles"]["width"]
        tile_height = images["Tiles"]["height"]
        zoom_levels = images["Zooms"]
        zoom_data = zoom_levels[zoom] if zoom < len(zoom_levels) else zoom_levels[-1]
        return {
            "image_id": image_id,
            "tile_width": tile_width,
            "tile_height": tile_height,
            "pano_width": zoom_data["width"],
            "pano_height": zoom_data["height"],
            "available_zooms": len(zoom_levels),
        }
    except (KeyError, IndexError, TypeError):
        return None


def resolve_panorama_meta(link: PanoLink, zoom: int, layers: Tuple[str, ...] = ("sta", "stv")) -> Dict:
    if link.pano_id:
        for layer in layers:
            data = _fetch_json(PANO_META_BY_ID_URL.format(layer=layer, pano_id=link.pano_id))
            if data:
                meta = _extract_pano_meta(data, zoom)
                if meta:
                    log.info(f"Метаданные найдены по oid={link.pano_id} (слой {layer})")
                    return meta
        log.warning(f"Не нашёл метаданные по oid={link.pano_id} в слоях {layers}, "
                    f"пробую по координатам.")
    for layer in layers:
        data = _fetch_json(PANO_META_BY_COORDS_URL.format(layer=layer, lon=link.lon, lat=link.lat))
        if data:
            meta = _extract_pano_meta(data, zoom)
            if meta:
                log.info(f"Метаданные найдены по координатам ({link.lon},{link.lat}), слой {layer}")
                if link.pano_id and meta["image_id"] != link.pano_id:
                    log.warning(f"Это не та панорама, что в ссылке (там id={link.pano_id}, "
                                f"найдено id={meta['image_id']}).")
                return meta
    raise RuntimeError(
        f"Не удалось найти панораму ни по id ({link.pano_id}), ни по координатам "
        f"({link.lon},{link.lat}) в слоях {layers}."
    )


async def _fetch_tile(session, url, semaphore, retries=4, base_delay=0.6):
    async with semaphore:
        last_error = None
        for attempt in range(1, retries + 1):
            try:
                async with session.get(
                    url, headers=TILE_HEADERS, timeout=aiohttp.ClientTimeout(total=20)
                ) as response:
                    if response.status == 200:
                        content = await response.read()
                        return Image.open(BytesIO(content)).convert("RGB")
                    last_error = f"HTTP {response.status}"
            except Exception as e:
                last_error = str(e)
            if attempt < retries:
                await asyncio.sleep(base_delay * attempt)
        log.debug(f"Тайл не скачался после {retries} попыток: {url} ({last_error})")
        return None


async def download_full_panorama(image_id, pano_width, pano_height, tile_width, tile_height, zoom, concurrency=12, retries=4):
    x_range = math.ceil(pano_width / tile_width)
    y_range = math.ceil(pano_height / tile_height)
    total_tiles = x_range * y_range

    pano = Image.new("RGB", (pano_width, pano_height))
    semaphore = asyncio.Semaphore(concurrency)
    connector = aiohttp.TCPConnector(limit=concurrency)

    log.info(f"Скачиваю панораму {image_id}: {pano_width}x{pano_height}px "
             f"({total_tiles} тайлов, zoom={zoom})...")

    async with aiohttp.ClientSession(connector=connector) as session:
        tasks, coords = [], []
        for x in range(x_range):
            for y in range(y_range):
                url = TILE_URL.format(image_id=image_id, zoom=zoom, x=x, y=y)
                tasks.append(_fetch_tile(session, url, semaphore, retries=retries))
                coords.append((x, y))
        results = await asyncio.gather(*tasks)

    failed = 0
    for (x, y), tile in zip(coords, results):
        if tile is not None:
            pano.paste(tile, (x * tile_width, y * tile_height))
        else:
            failed += 1

    success_rate = 100.0 * (total_tiles - failed) / total_tiles if total_tiles else 0.0
    log.info(f"Готово: {total_tiles - failed}/{total_tiles} тайлов ({success_rate:.1f}%)")
    if failed:
        log.warning(f"{failed} тайлов не скачались — на изображении могут быть чёрные пятна.")
        if success_rate < 90.0:
            log.warning("Успешность ниже 90% — попробуйте --concurrency 6 --retries 6.")

    return pano


def download_panorama_from_url(url, zoom=0, concurrency=12, retries=4, layers=("sta", "stv")):
    link = parse_pano_url(url)
    log.info(f"Ссылка разобрана: id={link.pano_id}, точка=({link.lon},{link.lat})")
    meta = resolve_panorama_meta(link, zoom, layers=layers)
    if platform.system() == "Windows":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    return asyncio.run(
        download_full_panorama(
            meta["image_id"], meta["pano_width"], meta["pano_height"],
            meta["tile_width"], meta["tile_height"], zoom,
            concurrency=concurrency, retries=retries,
        )
    )


def parse_args():
    p = argparse.ArgumentParser(description="Скачивает одну панораму Яндекс.Карт в хорошем качестве.")
    p.add_argument("--url", required=True, help="Ссылка на панораму Яндекс.Карт.")
    p.add_argument("--out", default=None, help="Путь для сохранения (по умолчанию pano_<id>.jpg).")
    p.add_argument("--zoom", type=int, default=0, help="0 — максимальное качество (по умолчанию).")
    p.add_argument("--quality", type=int, default=95, help="Качество JPEG (1-100).")
    p.add_argument("--concurrency", type=int, default=12, help="Максимум одновременных запросов тайлов.")
    p.add_argument("--retries", type=int, default=4, help="Число попыток скачать каждый тайл.")
    p.add_argument("--layers", default="sta,stv", help="Порядок слоёв через запятую.")
    p.add_argument("--log-file", default=None, help="Путь к файлу лога.")
    return p.parse_args()


def main():
    args = parse_args()
    setup_logging(args.log_file)
    layers = tuple(s.strip() for s in args.layers.split(",") if s.strip())
    try:
        image = download_panorama_from_url(
            args.url, zoom=args.zoom, concurrency=args.concurrency,
            retries=args.retries, layers=layers,
        )
    except RuntimeError as e:
        log.error(f"Не удалось скачать панораму: {e}")
        sys.exit(1)
    out_path = args.out
    if not out_path:
        link = parse_pano_url(args.url)
        out_path = f"pano_{link.pano_id or 'unknown'}.jpg"
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    image.save(out_path, quality=args.quality)
    log.info(f"\nГотово! Сохранено: {out_path} ({image.width}x{image.height})")


if __name__ == "__main__":
    main()
