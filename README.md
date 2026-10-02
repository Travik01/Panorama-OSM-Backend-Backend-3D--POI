# Panorama & OSM Backend

A backend system combining Yandex panorama downloading with OpenStreetMap geodata parsing. It downloads and assembles panorama tiles, extracts buildings with roof shapes and materials, roads with lane markings, trees, parks, water bodies, and POIs (schools, pharmacies, cafes, shops). Serves everything through Flask API endpoints with two-level caching (memory + disk).

---

## Overview

The system consists of three modules:

| Module | Purpose |
|--------|---------|
| `pano_downloader.py` | Downloads and assembles Yandex panorama images from tiles |
| `poi_parser.py` | Parses Points of Interest from OSM via Overpass API |
| `osm_buildings.py` | Fetches buildings, roads, trees, water from OSM; serves Flask API endpoints |

---

## Features

### Panorama Downloader
- Fetches panorama metadata by coordinates or panorama ID
- Assembles full-resolution panorama from tiles (async, 8 concurrent connections)
- Auto-height correction for 2:1 aspect ratio
- Airship (aerial) panorama discovery via vector tiles
- Disk caching by image_id

### POI Parser
- Queries OSM Overpass with regex-grouped tags (3 requests instead of 36)
- Parallel fetch from multiple Overpass instances — first success wins
- Categories: groceries, school, daycare, pharmacy, atm, gas, sport, cafe, restaurants, pvz
- Haversine distance calculation from query point
- Memory + disk cache (TTL 6 hours)

### OSM Buildings
- Buildings with height, roof shape, roof colour, material, levels from OSM tags
- Roads with lanes, width, surface, one-way, lane markings
- Tree generation in parks (procedural, density-based)
- Water bodies (lakes, rivers, ponds, reservoirs)
- Building–road collision filtering (buildings overlapping roads are removed)
- Floor plan upload/management (per-building)
- Nominatim geocoding for place search
- Disk cache (TTL 24 hours)

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/osm-buildings` | Fetch buildings, roads, trees, water for a location |
| GET | `/api/search` | Geocode a place name via Nominatim |
| GET | `/api/plans` | List all uploaded floor plans |
| POST | `/api/plans/upload` | Upload a floor plan image for a building |
| POST | `/api/plans/delete` | Delete a floor plan by coordinates |
| GET | `/plans/<filename>` | Serve a floor plan image |

### `/api/osm-buildings` Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `lat` | float | required | Latitude |
| `lon` | float | required | Longitude |
| `radius_m` | float | 300 | Search radius in meters (50–1000) |

### Response Structure

```json
{
  "status": "ok",
  "buildings": [
    {
      "ring": [[x, y], ...],
      "height": 12.0,
      "color": "#D4A574",
      "type": "residential",
      "name": "Жилой дом",
      "roof_shape": "gabled",
      "roof_colour": "#8B4513",
      "roof_height": 3.0,
      "material": "brick",
      "levels": "4",
      "dist_m": 45.2,
      "plan": null
    }
  ],
  "roads": [
    {
      "path": [[x, y], ...],
      "width": 8.0,
      "color": "#3d4246",
      "type": "primary",
      "lanes": 2,
      "oneway": false,
      "markings": true,
      "surface": "asphalt",
      "collision": true
    }
  ],
  "trees": [{"x": 12.3, "y": 45.6}],
  "greens": [[[x, y], ...]],
  "waters": [[[x, y], ...]],
  "count": 42,
  "radius_m": 300
}
```

All coordinates in buildings/roads/trees are **local offsets in meters** from the query point (origin = [0, 0]).

---

## Installation

```bash
pip install requests aiohttp Pillow Flask numpy
```

## requirements.txt

```text
requests>=2.31.0
aiohttp>=3.9.0
Pillow>=10.0.0
Flask>=3.0.0
numpy>=1.26.0
```

---

## Usage

### Start the Flask server

```python
from flask import Flask
from osm_buildings import osm_bp

app = Flask(__name__)
app.register_blueprint(osm_bp)
app.run(host="0.0.0.0", port=5000)
```

### Download a panorama

```python
from pano_downloader import download_panorama

meta = download_panorama(
    lat=57.1528,
    lon=65.5272,
    output_path="panorama.jpg",
    zoom=0
)
print(meta["panorama_id"], meta["name"])
```

### Check if panorama exists

```python
from pano_downloader import fetch_panorama_meta

try:
    meta = fetch_panorama_meta(57.1528, 65.5272)
    print(f"Found: {meta['panorama_id']}")
except PanoramaNotFound:
    print("No panorama nearby")
```

### Fetch POIs

```python
from poi_parser import fetch_poi_from_osm

pois = fetch_poi_from_osm(57.1528, 65.5272, radius_m=500)
for category, items in pois.items():
    for item in items:
        print(f"{category}: {item['title']} ({item['dist_m']}m)")
```

### Find aerial panoramas in an area

```python
from pano_downloader import fetch_airship_ids_for_bbox

result = fetch_airship_ids_for_bbox(
    west=65.40, south=57.10, east=65.60, north=57.20
)
print(f"Found {len(result['ids'])} aerial panoramas")
```

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  pano_downloader  │     │   poi_parser     │     │  osm_buildings    │
│                  │     │                  │     │                  │
│  Yandex Panoramas│     │  OSM Overpass    │     │  OSM Overpass    │
│  (api-maps.yandex│     │  (POI: schools,  │     │  (buildings,     │
│   .ru)           │     │   pharmacies,    │     │   roads, trees,  │
│                  │     │   cafes, shops)  │     │   water, parks)  │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                          ┌───────┴───────┐
                          │   Flask API    │
                          │   /api/...     │
                          └───────┬───────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │    Two-Level Cache        │
                    │  memory (LRU 500) +      │
                    │  disk (cache/*.json)     │
                    └─────────────────────────┘
```

---

## Cache Structure

```
cache/
├── poi/                    # POI cache (TTL: 6h)
│   └── <hash>.json
└── osm_buildings/          # Buildings cache (TTL: 24h)
    └── <hash>.json
```

Cache keys are hashed by `lat`, `lon`, `radius` (5 decimal places).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKY_TILE_MAX_TILES` | 96 | Max vector tiles for aerial panorama search |
| `YANDEX_STV_VERSION` | — | Override Yandex STV layer version |
| `YANDEX_STV_VERSION_TTL_SECONDS` | 3600 | How long to cache the STV version |

---

## Overpass Instances

Queries are sent in parallel to 3 fastest instances; first success wins:

1. `overpass.kumi.systems`
2. `maps.mail.ru`
3. `overpass.openstreetmap.ru`

Fallback: sequential attempts to all 4 instances.

---

## Project Structure

```
panorama-osm-backend/
├── pano_downloader.py          # Yandex panorama downloader
├── poi_parser.py               # OSM POI parser
├── osm_buildings.py            # OSM buildings + Flask API
├── cache/
│   ├── poi/                    # POI disk cache
│   └── osm_buildings/          # Buildings disk cache
├── plans/                      # Uploaded floor plan images
├── plans.txt                   # Floor plan index
├── requirements.txt
└── README.md
```

---

## Notes

- Yandex panorama API is undocumented and may be rate-limited or blocked at any time
- Overpass queries use `maxsize: 16 MB` and `timeout: 15–20s`
- Building–road collision detection removes buildings whose polygons overlap drivable roads
- Trees are generated procedurally in parks based on area and density, then filtered against buildings
- All local coordinates are in meters relative to the query point

## License

MIT

---

# Panorama & OSM Backend

Backend-система, объединяющая загрузку панорам Яндекс.Карт и парсинг геоданных OpenStreetMap. Скачивает и склеивает панорамные тайлы, извлекает здания с высотами, формами и материалами крыш, дороги с разметкой полос, деревья, парки и водоёмы, а также точки интереса (POI) — школы, аптеки, кафе, магазины. Отдаёт данные через Flask API с двухуровневым кэшированием (память + диск).

---

## Обзор

Система состоит из трёх модулей:

| Модуль | Назначение |
|--------|------------|
| `pano_downloader.py` | Скачивание и сборка панорам Яндекс.Карт из тайлов |
| `poi_parser.py` | Парсинг точек интереса (POI) из OSM через Overpass API |
| `osm_buildings.py` | Получение зданий, дорог, деревьев, водоёмов из OSM; Flask API |

---

## Возможности

### Загрузчик панорам
- Получение метаданных панорамы по координатам или по ID
- Сборка полноразмерной панорамы из тайлов (async, 8 параллельных соединений)
- Автокоррекция высоты для соотношения 2:1
- Поиск воздушных панорам через vector tiles
- Кэширование на диск по image_id

### Парсер POI
- Запросы к OSM Overpass с regex-группировкой тегов (3 запроса вместо 36)
- Параллельный опрос нескольких инстансов Overpass — первый успех выигрывает
- Категории: продукты, школы, детсады, аптеки, банкоматы, заправки, спорт, кафе, рестораны, ПВЗ
- Расчёт расстояния Хаверсина от точки запроса
- Кэш в памяти + на диске (TTL 6 часов)

### Здания OSM
- Здания с высотой, формой крыши, цветом крыши, материалом, этажностью из тегов OSM
- Дороги с полосами, шириной, покрытием, односторонним движением, разметкой
- Генерация деревьев в парках (процедурная, на основе плотности)
- Водоёмы (озёра, реки, пруды, водохранилища)
- Фильтрация столкновений здание–дорога (здания, перекрывающие дороги, удаляются)
- Загрузка/управление планами этажей (для отдельных зданий)
- Геокодирование мест через Nominatim
- Кэш на диске (TTL 24 часа)

---

## API эндпоинты

| Метод | Маршрут | Описание |
|------|---------|----------|
| GET | `/api/osm-buildings` | Получить здания, дороги, деревья, водоёмы для точки |
| GET | `/api/search` | Геокодирование названия места через Nominatim |
| GET | `/api/plans` | Список всех загруженных планов этажей |
| POST | `/api/plans/upload` | Загрузить изображение плана этажа для здания |
| POST | `/api/plans/delete` | Удалить план этажа по координатам |
| GET | `/plans/<filename>` | Отдать изображение плана этажа |

### Параметры `/api/osm-buildings`

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `lat` | float | обязательно | Широта |
| `lon` | float | обязательно | Долгота |
| `radius_m` | float | 300 | Радиус поиска в метрах (50–1000) |

### Структура ответа

```json
{
  "status": "ok",
  "buildings": [
    {
      "ring": [[x, y], ...],
      "height": 12.0,
      "color": "#D4A574",
      "type": "residential",
      "name": "Жилой дом",
      "roof_shape": "gabled",
      "roof_colour": "#8B4513",
      "roof_height": 3.0,
      "material": "brick",
      "levels": "4",
      "dist_m": 45.2,
      "plan": null
    }
  ],
  "roads": [...],
  "trees": [{"x": 12.3, "y": 45.6}],
  "greens": [...],
  "waters": [...],
  "count": 42,
  "radius_m": 300
}
```

Все координаты в buildings/roads/trees — **локальные смещения в метрах** от точки запроса (начало = [0, 0]).

---

## Установка

```bash
pip install -r requirements.txt
```

`requirements.txt`:
```text
requests>=2.31.0
aiohttp>=3.9.0
Pillow>=10.0.0
Flask>=3.0.0
numpy>=1.26.0
```

---

## Использование

### Запуск Flask-сервера

```python
from flask import Flask
from osm_buildings import osm_bp

app = Flask(__name__)
app.register_blueprint(osm_bp)
app.run(host="0.0.0.0", port=5000)
```

### Скачивание панорамы

```python
from pano_downloader import download_panorama

meta = download_panorama(
    lat=57.1528,
    lon=65.5272,
    output_path="panorama.jpg",
    zoom=0
)
print(meta["panorama_id"], meta["name"])
```

### Проверка наличия панорамы

```python
from pano_downloader import fetch_panorama_meta

try:
    meta = fetch_panorama_meta(57.1528, 65.5272)
    print(f"Найдена: {meta['panorama_id']}")
except PanoramaNotFound:
    print("Панорамы рядом нет")
```

### Получение POI

```python
from poi_parser import fetch_poi_from_osm

pois = fetch_poi_from_osm(57.1528, 65.5272, radius_m=500)
for category, items in pois.items():
    for item in items:
        print(f"{category}: {item['title']} ({item['dist_m']}м)")
```

### Поиск воздушных панорам в области

```python
from pano_downloader import fetch_airship_ids_for_bbox

result = fetch_airship_ids_for_bbox(
    west=65.40, south=57.10, east=65.60, north=57.20
)
print(f"Найдено воздушных панорам: {len(result['ids'])}")
```

---

## Архитектура

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  pano_downloader  │     │   poi_parser     │     │  osm_buildings    │
│                  │     │                  │     │                  │
│  Яндекс.Панорамы │     │  OSM Overpass    │     │  OSM Overpass    │
│  (api-maps.yandex│     │  (POI: школы,    │     │  (здания, дороги,│
│   .ru)           │     │   аптеки, кафе,  │     │   деревья, вода, │
│                  │     │   магазины)      │     │   парки)         │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                          ┌───────┴───────┐
                          │   Flask API    │
                          │   /api/...     │
                          └───────┬───────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │    Двухуровневый кэш       │
                    │  память (LRU 500) +        │
                    │  диск (cache/*.json)       │
                    └───────────────────────────┘
```

---

## Структура кэша

```
cache/
├── poi/                    # Кэш POI (TTL: 6 ч)
│   └── <hash>.json
└── osm_buildings/          # Кэш зданий (TTL: 24 ч)
    └── <hash>.json
```

Ключи кэша хешируются по `lat`, `lon`, `radius` (5 знаков после запятой).

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `SKY_TILE_MAX_TILES` | 96 | Максимум vector tiles для поиска воздушных панорам |
| `YANDEX_STV_VERSION` | — | Переопределить версию слоя STV Яндекса |
| `YANDEX_STV_VERSION_TTL_SECONDS` | 3600 | Время жизни кэша версии STV |

---

## Инстансы Overpass

Запросы отправляются параллельно на 3 самых быстрых инстанса; первый успех выигрывает:

1. `overpass.kumi.systems`
2. `maps.mail.ru`
3. `overpass.openstreetmap.ru`

Fallback: последовательные попытки по всем 4 инстансам.

---

## Структура проекта

```
panorama-osm-backend/
├── pano_downloader.py          # Загрузчик панорам Яндекса
├── poi_parser.py               # Парсер POI из OSM
├── osm_buildings.py            # Здания OSM + Flask API
├── cache/
│   ├── poi/                    # Дисковый кэш POI
│   └── osm_buildings/          # Дисковый кэш зданий
├── plans/                      # Загруженные планы этажей
├── plans.txt                   # Индекс планов этажей
├── requirements.txt
└── README.md
```

---

## Примечания

- API панорам Яндекса недокументирован и может быть ограничен или заблокирован в любой момент
- Запросы Overpass используют `maxsize: 16 МБ` и `timeout: 15–20 с`
- Детекция столкновений здание–дорога удаляет здания, полигоны которых перекрывают проезжие дороги
- Деревья генерируются процедурно в парках на основе площади и плотности, затем фильтруются от зданий
- Все локальные координаты — в метрах относительно точки запроса


