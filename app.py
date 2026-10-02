"""OSM + Yandex Panorama Points — Flask-приложение с картой OSM, админкой и 360°-панорамами Яндекс.Карт."""

import csv
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from functools import wraps
from math import asin, cos, radians, sin, sqrt

from flask import Flask, g, jsonify, render_template, request, send_from_directory, session

from osm_buildings import osm_bp
from poi_parser import fetch_poi_from_osm
from pano_downloader import (
    DEFAULT_TILE_LIMIT,
    PanoramaLayerError,
    PanoramaNotFound,
    download_panorama,
    fetch_airship_ids_for_bbox,
    fetch_panorama_meta,
    fetch_panorama_meta_by_id,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "points.db")
PANO_CACHE_DIR = os.path.join(BASE_DIR, "static", "panoramas")
MARKERS_DIR = os.path.join(BASE_DIR, "markers")

DISABLE_PANO_CACHE_CLEAN = os.environ.get("DISABLE_PANO_CACHE_CLEAN", "") in {"1", "true", "yes"}


def _maybe_clean_pano_cache() -> None:
    if DISABLE_PANO_CACHE_CLEAN:
        return
    try:
        if os.path.isdir(PANO_CACHE_DIR):
            import shutil
            shutil.rmtree(PANO_CACHE_DIR)
        os.makedirs(PANO_CACHE_DIR, exist_ok=True)
    except Exception:
        pass


app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "change-me-please")
app.register_blueprint(osm_bp)


@app.after_request
def allow_iframe(response):
    if request.path.startswith("/embed"):
        response.headers.pop("X-Frame-Options", None)
        response.headers["Content-Security-Policy"] = "frame-ancestors *;"
        response.headers["Access-Control-Allow-Origin"] = "*"
    return response


ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
DEFAULT_PANO_ZOOM = int(os.environ.get("PANO_ZOOM", "2"))

os.makedirs(PANO_CACHE_DIR, exist_ok=True)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS points (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                description TEXT DEFAULT '',
                lat         REAL NOT NULL,
                lon         REAL NOT NULL,
                created_at  TEXT NOT NULL
            )
            """
        )
        db.commit()


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("is_admin"):
            return jsonify({"error": "Требуются права администратора"}), 403
        return view(*args, **kwargs)
    return wrapped


@app.route("/")
def index():
    return render_template("index.html", is_admin=bool(session.get("is_admin")))


@app.route("/embed")
@app.route("/embed/3d")
def embed_3d():
    return render_template("embed.html")


@app.route("/test-external")
@app.route("/demo")
@app.route("/demo-embed")
def test_external():
    return render_template("test_external.html")


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    password = data.get("password", "")
    if password and password == ADMIN_PASSWORD:
        session["is_admin"] = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Неверный пароль"}), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("is_admin", None)
    return jsonify({"ok": True})


@app.route("/api/session", methods=["GET"])
def session_status():
    return jsonify({"is_admin": bool(session.get("is_admin"))})


@app.route("/api/points", methods=["GET"])
def list_points():
    db = get_db()
    rows = db.execute(
        "SELECT id, title, description, lat, lon, created_at FROM points ORDER BY id DESC"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/points", methods=["POST"])
@admin_required
def create_point():
    data = request.get_json(silent=True) or {}
    try:
        lat = float(data["lat"])
        lon = float(data["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Некорректные координаты"}), 400

    title = (data.get("title") or "").strip() or f"Точка {lat:.5f}, {lon:.5f}"
    description = (data.get("description") or "").strip()

    db = get_db()
    cur = db.execute(
        "INSERT INTO points (title, description, lat, lon, created_at) VALUES (?, ?, ?, ?, ?)",
        (title, description, lat, lon, datetime.now(timezone.utc).isoformat()),
    )
    db.commit()

    return jsonify(
        {
            "id": cur.lastrowid,
            "title": title,
            "description": description,
            "lat": lat,
            "lon": lon,
        }
    ), 201


@app.route("/api/points/<int:point_id>", methods=["DELETE"])
@admin_required
def delete_point(point_id):
    db = get_db()
    db.execute("DELETE FROM points WHERE id = ?", (point_id,))
    db.commit()
    return jsonify({"ok": True})


POI_CSV_PATH = os.path.join(BASE_DIR, "results_8cat_tyumen_v88.csv")

POI_CATEGORIES = {
    "pvz": "ПВЗ",
    "groceries": "Продукты",
    "shopping_mall": "Торговые центры",
    "restaurants": "Рестораны",
    "daycare": "Детские сады",
    "school": "Школы",
    "pharmacy": "Аптеки",
    "atm": "Банкоматы",
    "gas": "АЗС",
    "sport": "Спорт",
    "cafe": "Кафе",
}

_poi_by_category = None
_poi_parse_info = None


def _haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    phi1 = radians(lat1)
    phi2 = radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lam = radians(lon2 - lon1)
    a = sin(d_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(d_lam / 2) ** 2
    c = 2 * asin(min(1.0, sqrt(a)))
    return r * c


def _pick_first(row, keys):
    for k in keys:
        v = row.get(k)
        if v is not None and str(v).strip() != "":
            return v
    return ""


def _parse_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_poi_csv_once():
    global _poi_by_category, _poi_parse_info
    if _poi_by_category is not None:
        return

    poi_by_category = {key: [] for key in POI_CATEGORIES.keys()}
    parse_info = {
        "csv_path": POI_CSV_PATH,
        "loaded": False,
        "fieldnames": None,
        "rows_total": 0,
        "rows_used": 0,
        "by_category": {key: 0 for key in POI_CATEGORIES.keys()},
        "errors": [],
    }

    if not os.path.exists(POI_CSV_PATH):
        _poi_by_category = poi_by_category
        _poi_parse_info = parse_info
        return

    with open(POI_CSV_PATH, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        parse_info["fieldnames"] = list(reader.fieldnames or [])
        for row in reader:
            parse_info["rows_total"] += 1
            category_key = _pick_first(row, ["category_key", "categoryKey", "category", "type"]).strip()
            if category_key not in POI_CATEGORIES:
                continue
            lat = _parse_float(_pick_first(row, ["lat", "latitude", "Lat"]))
            lon = _parse_float(_pick_first(row, ["lon", "lng", "longitude", "Lon"]))
            if lat is None or lon is None:
                continue
            title = _pick_first(row, ["title", "name", "object_name"]).strip()
            org_url = _pick_first(row, ["org_url", "orgUrl", "url", "org"]).strip()
            if not title:
                continue
            poi_by_category[category_key].append(
                {"title": title, "lat": lat, "lon": lon, "org_url": org_url}
            )
            parse_info["rows_used"] += 1
            parse_info["by_category"][category_key] += 1

    parse_info["loaded"] = True
    _poi_by_category = poi_by_category
    _poi_parse_info = parse_info


@app.route("/api/poi-summary", methods=["GET"])
def poi_summary():
    _parse_poi_csv_once()
    if not _poi_by_category:
        return jsonify({"status": "error", "message": "POI данные не загружены"}), 500
    if _poi_parse_info and not _poi_parse_info.get("loaded"):
        return jsonify({"status": "error", "message": "POI CSV не найден или не прочитан"}), 500

    try:
        target_lat = float(request.args.get("lat"))
        target_lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Некорректные координаты"}), 400

    radius_m = request.args.get("radius_m", type=float, default=500.0)
    if radius_m <= 0:
        radius_m = 100.0

    categories_out = []
    # Данные из OSM-парсера дополняют CSV
    try:
        parser_data = fetch_poi_from_osm(target_lat, target_lon, radius_m)
    except Exception:
        parser_data = {}

    for key, cat_name in POI_CATEGORIES.items():
        items_by_coord = {}

        # 1. CSV (БД) — приоритет
        for poi in _poi_by_category.get(key, []):
            dist_m = _haversine_m(target_lat, target_lon, poi["lat"], poi["lon"])
            if dist_m > radius_m:
                continue
            coord_key = (round(poi["lat"], 4), round(poi["lon"], 4))
            if coord_key in items_by_coord:
                continue
            items_by_coord[coord_key] = {
                "title": poi["title"],
                "dist_m": round(dist_m, 1),
                "org_url": poi.get("org_url") or "",
                "lat": poi["lat"],
                "lon": poi["lon"],
                "source": "db"
            }

        # 2. OSM-парсер — только если координат нет в БД
        for poi in parser_data.get(key, []):
            coord_key = (round(poi["lat"], 4), round(poi["lon"], 4))
            if coord_key in items_by_coord:
                continue
            items_by_coord[coord_key] = {
                "title": poi["title"],
                "dist_m": poi["dist_m"],
                "org_url": poi.get("org_url") or "",
                "lat": poi["lat"],
                "lon": poi["lon"],
                "source": "osm"
            }

        items = list(items_by_coord.values())
        items.sort(key=lambda x: x["dist_m"])
        categories_out.append({"key": key, "name": cat_name, "count": len(items), "items": items})

    return jsonify({"status": "ok", "radius_m": radius_m, "categories": categories_out, "poi_loaded": True})


POI_CATEGORY_ICONS = {
    "school": "school.png",
    "atm": "atm.png",
    "cafe": "cafes.png",
    "groceries": "groceries.png",
    "daycare": "kindergarten.png",
    "pharmacy": "pharmacy.png",
    "pvz": "pvz.png",
    "restaurants": "restaraunt.png",
    "shopping_mall": "sc.png",
    "gas": "gas.png",
    "sport": "sport.png"
}

MARKER_COLORS_CONFIG_PATH = os.path.join(BASE_DIR, "marker_colors.json")
_marker_colors_cache = None


def _load_marker_colors():
    global _marker_colors_cache
    if _marker_colors_cache is not None:
        return _marker_colors_cache
    try:
        import json
        with open(MARKER_COLORS_CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        colors = {}
        for k, v in raw.items():
            if k.startswith("_"):
                continue
            if isinstance(v, dict) and "color" in v:
                colors[k] = v["color"]
            elif isinstance(v, str):
                colors[k] = v
        _marker_colors_cache = colors
        return colors
    except Exception:
        _marker_colors_cache = {}
        return {}


@app.route("/markers/<path:filename>")
def marker_icon(filename):
    return send_from_directory(MARKERS_DIR, filename)


@app.route("/api/poi-icons", methods=["GET"])
def poi_icons():
    icons = {}
    for key, filename in POI_CATEGORY_ICONS.items():
        if os.path.exists(os.path.join(MARKERS_DIR, filename)):
            icons[key] = f"/markers/{filename}"
    return jsonify(icons)


@app.route("/api/marker-colors", methods=["GET"])
def marker_colors():
    import json
    try:
        with open(MARKER_COLORS_CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        out = {k: v for k, v in raw.items() if not k.startswith("_")}
        return jsonify(out)
    except Exception:
        return jsonify(_load_marker_colors())


@app.route("/api/marker-config", methods=["GET"])
def marker_config_combined():
    colors = {}
    try:
        import json
        with open(MARKER_COLORS_CONFIG_PATH, "r", encoding="utf-8") as f:
            colors = json.load(f)
    except Exception:
        colors = {}

    combined = {}
    for key in POI_CATEGORIES.keys():
        icon_file = POI_CATEGORY_ICONS.get(key)
        color_info = colors.get(key, {}) if isinstance(colors.get(key), dict) else {"color": colors.get(key, "#CCCCCC")}
        if isinstance(color_info, str):
            color_info = {"color": color_info}
        combined[key] = {
            "name": POI_CATEGORIES.get(key, key),
            "icon": f"/markers/{icon_file}" if icon_file and os.path.exists(os.path.join(MARKERS_DIR, icon_file)) else None,
            "color": color_info.get("color", "#CCCCCC"),
            "file": icon_file
        }
    return jsonify(combined)


# Панорамы Яндекс.Карт — недокументированный эндпоинт, без apikey

def _cache_path(image_id, zoom):
    safe_id = "".join(c if c.isalnum() or c in "-_." else "_" for c in image_id)
    filename = f"{safe_id}_{zoom}.jpg"
    return os.path.join(PANO_CACHE_DIR, filename)


@app.route("/api/panorama", methods=["GET"])
def get_panorama():
    pano_id = (request.args.get("id") or request.args.get("pano_id") or "").strip()
    zoom = request.args.get("zoom", type=int, default=DEFAULT_PANO_ZOOM)

    try:
        if pano_id:
            meta = fetch_panorama_meta_by_id(pano_id, layer="sta")
            lat = lon = None
        else:
            try:
                lat = float(request.args.get("lat"))
                lon = float(request.args.get("lon"))
            except (TypeError, ValueError):
                return jsonify({"status": "error", "message": "Некорректные координаты"}), 400
            meta = fetch_panorama_meta(lat, lon, layer="sta")
    except PanoramaNotFound:
        return jsonify({"status": "not_found"})
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 502

    max_width = 8192
    if zoom < len(meta["zooms"]):
        width = meta["zooms"][zoom]["width"]
        while width > max_width and zoom + 1 < len(meta["zooms"]):
            zoom += 1
            width = meta["zooms"][zoom]["width"]

    cache_file = _cache_path(meta["image_id"], zoom)
    rel_url = f"/static/panoramas/{os.path.basename(cache_file)}"

    # Проверяем валидность кэшированного JPG
    def _is_valid_jpg(path):
        try:
            from PIL import Image
            im = Image.open(path)
            im.verify()
            return True
        except Exception:
            return False

    need_download = not os.path.exists(cache_file) or not _is_valid_jpg(cache_file)

    force = str(request.args.get("force", "")).lower() in {"1", "true", "yes"}
    if force:
        need_download = True

    if need_download:
        try:
            if os.path.exists(cache_file):
                try:
                    os.remove(cache_file)
                except Exception:
                    pass
            download_panorama(lat, lon, cache_file, zoom=zoom, layer="sta", pano_id=pano_id or None)
        except PanoramaNotFound:
            return jsonify({"status": "not_found"})
        except Exception as exc:
            return jsonify({"status": "error", "message": str(exc)}), 502

    pano_point = meta.get("pano_point") or {}
    return jsonify(
        {
            "status": "ready",
            "url": rel_url,
            "panorama_id": meta.get("panorama_id"),
            "image_id": meta["image_id"],
            "pano_lat": pano_point.get("lat"),
            "pano_lon": pano_point.get("lon"),
            "name": meta.get("name") or "",
            "height": meta.get("height"),
        }
    )


def _point_from_airship_meta(meta):
    pano_point = meta.get("pano_point") or {}
    lat = pano_point.get("lat")
    lon = pano_point.get("lon")
    if lat is None or lon is None:
        return None

    timestamp = meta.get("timestamp")
    captured_at = None
    if timestamp:
        captured_at = datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat()

    title = meta.get("name") or "Воздушная панорама"
    description_parts = []
    if meta.get("height") is not None:
        description_parts.append(f"Высота: {round(float(meta['height']))} м")
    if captured_at:
        description_parts.append(f"Дата съёмки: {captured_at}")

    return {
        "id": meta.get("panorama_id"),
        "title": title,
        "description": " · ".join(description_parts),
        "lat": lat,
        "lon": lon,
        "height": meta.get("height"),
        "captured_at": captured_at,
    }


@app.route("/api/sky-panoramas", methods=["GET"])
def list_sky_panoramas():
    raw_bbox = request.args.get("bbox", "")
    try:
        west, south, east, north = [float(value) for value in raw_bbox.split(",")]
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Некорректный bbox"}), 400

    zoom = request.args.get("zoom", type=int, default=12)
    max_tiles = request.args.get("max_tiles", type=int, default=DEFAULT_TILE_LIMIT)
    max_tiles = max(1, min(max_tiles, 256))
    max_ids = request.args.get("max_ids", type=int, default=500)
    max_ids = max(1, min(max_ids, 1000))

    try:
        tile_data = fetch_airship_ids_for_bbox(west, south, east, north, map_zoom=zoom, max_tiles=max_tiles)
    except (PanoramaLayerError, Exception) as exc:
        return jsonify({"status": "error", "message": str(exc)}), 502

    pano_ids = tile_data["ids"][:max_ids]
    points = []

    def load_meta(pano_id):
        return fetch_panorama_meta_by_id(pano_id, layer="sta")

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(load_meta, pano_id): pano_id for pano_id in pano_ids}
        for future in as_completed(futures):
            try:
                point = _point_from_airship_meta(future.result())
            except Exception:
                continue
            if not point:
                continue
            if south <= point["lat"] <= north and west <= point["lon"] <= east:
                points.append(point)

    points.sort(key=lambda point: (point["title"], point["id"] or ""))

    return jsonify(
        {
            "status": "ok",
            "points": points,
            "tile_zoom": tile_data["tile_zoom"],
            "tile_count": tile_data["tile_count"],
            "partial": bool(tile_data["partial"] or len(tile_data["ids"]) > len(pano_ids)),
            "checked_ids": len(pano_ids),
            "total_tile_ids": len(tile_data["ids"]),
        }
    )


if __name__ == "__main__":
    _maybe_clean_pano_cache()
    init_db()
    app.run(debug=True, host="0.0.0.0", port=8080)
