#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Yandex Maps – MULTI category via FIXED URLs
# Каждая категория скрапится с одного фиксированного URL (из urls.txt).
# URL не пересобирается — используется как есть, с sctx для полного списка.

import argparse, time, re, json, csv, sys
from pathlib import Path

SCHOOLS_URL = (
    "https://yandex.com/maps/55/tyumen/category/school/184106240/"
    "?l=stv%2Csta"
    "&ll=65.575412%2C57.173220"
    "&sctx=ZAAAAAgBEAAaKAoSCc0%2F%2BiZNZFBAEYNStHIvlExAEhIJZjGx%2Bbg2dD8RaFn3j4XoYD8iBgABAgMEBSgKOABAsJ8NSAFqAnJ1nQHNzMw9oAEAqAEAvQFmETRZwgGDAYyAhJgFpZTh7wOt68H3ngbo5e7mA8j16e0Dx%2FmD6QOgzbPgA%2BXp0oUE7%2BTRsJ0D147nivYBpuTx5wPZs8iO%2FwOx6fewygWauuyYBMLl15MEj9n1hQSpmKbwA6iWrvYD9r2k%2BwPg3brwA%2FuM5%2BYDmej7%2FAOqlK6FBOmJqs3zBeyr8N8DggIbKChjYXRlZ29yeV9pZDooMTg0MTA2MjQwKSkpigIJMTg0MTA2MjQwkgIAmgIMZGVza3RvcC1tYXBz"
    "&sll=65.579061%2C57.173220"
    "&sspn=0.298819%2C0.124909"
    "&z=12"
)

BUILTIN = [
    {"key": "school", "name_ru": "Школы", "display_en": "Schools", "url": SCHOOLS_URL},
]

KEY_NAMES = {
    "pharmacy": ("Аптеки", "Pharmacies"),
    "atm": ("Банкоматы", "ATMs"),
    "gas_station": ("АЗС", "Gas stations"),
    "sports_club": ("Спорт", "Sport"),
    "cafe": ("Кафе", "Cafes"),
    "shopping_mall": ("Торговые центры", "Shopping malls"),
    "supermarket": ("Продукты", "Groceries"),
    "restaurant": ("Рестораны", "Restaurants"),
    "school": ("Школы", "Schools"),
}

JUNK_STARTS = ("фото", "рейтинг", "отзыв", "оцен", "меню", "цены", "панорама",
               "открыто", "закрыто", "подробнее", "показать", "ещё", "еще",
               "сохранить", "построить", "на карте", "маршрут")
JUNK_EXACT = {"фото", "", "•", "·", "...", "—", "-", "–"}


def is_junk(s):
    if not s:
        return True
    t = s.lower().strip()
    if len(t) < 2 or t in JUNK_EXACT:
        return True
    return any(t.startswith(j) for j in JUNK_STARTS)


def clean_text(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def org_id_from_href(href):
    if not href:
        return ""
    m = re.search(r'/org/[^/]*/(\d+)', href) or re.search(r'/org/(\d+)', href)
    return m.group(1) if m else ""


def coords_from_url(url):
    if not url:
        return "", ""
    for pat in (r'll=([\d\.\-]+)%2C([\d\.\-]+)', r'll=([\d\.\-]+),([\d\.\-]+)'):
        m = re.search(pat, url)
        if m:
            return m.group(2), m.group(1)
    return "", ""


def domain_of(url):
    m = re.search(r'https?://([^/]+)/', url)
    return m.group(1) if m else "yandex.com"


def key_from_url(url):
    m = re.search(r'/category/([^/]+)/', url)
    if m:
        return m.group(1)
    m = re.search(r'/search/([^/?]+)', url)
    if m:
        from urllib.parse import unquote
        return unquote(m.group(1)).strip().lower().replace(" ", "_")
    return "cat"


def looks_like_captcha(page):
    try:
        u = (page.url or "").lower()
        if "showcaptcha" in u or "/captcha" in u:
            return True
        body = (page.inner_text("body") or "").lower()
    except Exception:
        return False
    markers = ["подтвердите, что запросы отправляли вы",
               "i'm not a robot", "confirm that you", "captcha"]
    return any(mk in body for mk in markers)


def build_coord_index_from_html(html):
    index = {}
    if not html:
        return index
    coord_iter = list(re.finditer(r'"(?:coordinates|coordinate|point)"\s*:\s*[\{$$]?\s*(?:"lon"\s*:\s*)?([\d\.\-]+)\s*,\s*(?:"lat"\s*:\s*)?([\d\.\-]+)', html))    
    for m in coord_iter:        
        a, b = m.group(1), m.group(2)       
        try:            
            fa, fb = float(a), float(b)        
        except ValueError:            
            continue        
        if -90 <= fb <= 90 and abs(fa) > 90:            
            lon, lat = a, b        
        elif -90 <= fa <= 90 and abs(fb) > 90:            
            lon, lat = b, a        
        else:           
            lon, lat = a, b      
            start = max(0, m.start() - 800)       
            window = html[start:m.end() + 800]     
            ids = re.findall(r'/org/[^/"\$$+/(\d{6,})', window)
        if not ids:
            ids = re.findall(r'"(?:id|oid|permalink|business_oid)"\s*:\s*"?(\d{8,})"?', window)
        for oid in ids:
            index.setdefault(oid, (lat, lon))
    return index


def scroll_to_bottom(page, max_stalls=8, pause_ms=700, hard_limit=400):
    list_selectors = [".scroll__container", "[class*='scroll__container']",
                      ".search-list-view__list", "[class*='search-list-view']"]
    card_sel = "a[href*='/org/']"

    def count():
        try:
            return len(page.query_selector_all(card_sel))
        except Exception:
            return 0

    last = count(); stalls = 0; iters = 0
    while stalls < max_stalls and iters < hard_limit:
        iters += 1
        scrolled = False
        for sel in list_selectors:
            el = page.query_selector(sel)
            if el:
                try:
                    page.eval_on_selector(sel, "e => e.scrollBy(0, e.scrollHeight)")
                    scrolled = True
                    break
                except Exception:
                    pass
        if not scrolled:
            page.mouse.wheel(0, 3000)
            try:
                page.keyboard.press("End")
            except Exception:
                pass
        for txt in ["Показать ещё", "Показать еще", "Show more", "Ещё"]:
            try:
                btn = page.get_by_text(txt, exact=False).first
                if btn and btn.is_visible(timeout=150):
                    btn.click(timeout=400)
                    page.wait_for_timeout(400)
                    break
            except Exception:
                pass
        page.wait_for_timeout(pause_ms)
        now = count()
        if now > last:
            last = now; stalls = 0
            print(f"    …loaded {now} cards", end="\r", flush=True)
        else:
            stalls += 1
    print(f"    scroll done: {last} card links after {iters} iterations        ")
    return last


def parse_cards(page, domain, coord_index):
    rows = []
    seen_ids = set()
    try:
        anchors = page.query_selector_all("a[href*='/org/']")
    except Exception:
        anchors = []
    for a in anchors:
        try:
            href = a.get_attribute("href") or ""
            oid = org_id_from_href(href)
            if not oid or oid in seen_ids:
                continue
            title = clean_text(a.inner_text())
            if is_junk(title):
                try:
                    cont = a.evaluate_handle(
                        "el => el.closest(\"[class*='snippet']\") || el.closest('li') || el.parentElement")
                    el = cont.as_element() if cont else None
                    title_el = el.query_selector("[class*='snippet-view__title'], [class*='title']") if el else None
                    if title_el:
                        title = clean_text(title_el.inner_text())
                except Exception:
                    pass
                if is_junk(title):
                    continue
            seen_ids.add(oid)
            address, rating = "", ""
            try:
                cont = a.evaluate_handle(
                    "el => el.closest(\"[class*='snippet']\") || el.closest('li') || el.parentElement")
                el = cont.as_element() if cont else None
                if el:
                    addr_el = el.query_selector("[class*='address']")
                    if addr_el:
                        address = clean_text(addr_el.inner_text())
                    r_el = el.query_selector("[class*='rating__value'], [class*='business-rating']")
                    if r_el:
                        rating = clean_text(r_el.inner_text())
            except Exception:
                pass
            if href.startswith("/"):
                href = f"https://{domain}" + href
            clean_href = href.split("?")[0]
            lat, lon = "", ""
            if oid in coord_index:
                lat, lon = coord_index[oid]
            if not lat:
                lat, lon = coords_from_url(href)
            rows.append({"title": title, "address": address, "lat": lat, "lon": lon,
                         "rating": rating, "org_url": clean_href, "org_id": oid})
        except Exception:
            continue
    return rows


def fetch_coords_for_org(context, org_url, timeout=20000):
    lat, lon = "", ""
    pg = None
    try:
        pg = context.new_page()
        pg.goto(org_url, wait_until="domcontentloaded", timeout=timeout)
        pg.wait_for_timeout(1500)
        lat, lon = coords_from_url(pg.url)
        if not lat:
            html = pg.content()
            m = re.search(r'"coordinates"\s*:\s*$$\s*([\d\.\-]+)\s*,\s*([\d\.\-]+)\s*$$', html)
            if m:
                lon, lat = m.group(1), m.group(2)
        if not lat:
            m = re.search(r'll=([\d\.\-]+)(?:%2C|,)([\d\.\-]+)', pg.content())
            if m:
                lon, lat = m.group(1), m.group(2)
    except Exception:
        pass
    finally:
        if pg:
            try:
                pg.close()
            except Exception:
                pass
    return lat, lon


def load_targets(urls_path, ru):
    targets = {t["key"]: dict(t) for t in BUILTIN}
    path = Path(urls_path)
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "|" in line:
                parts = [p.strip() for p in line.split("|")]
                url = parts[-1]
                key = parts[0] if len(parts) >= 1 and parts[0] else key_from_url(url)
                name_ru = parts[1] if len(parts) >= 2 and parts[1] else KEY_NAMES.get(key, (key, key))[0]
                name_en = parts[2] if len(parts) >= 3 and parts[2] else KEY_NAMES.get(key, (key, key))[1]
            else:
                url = line
                key = key_from_url(url)
                name_ru, name_en = KEY_NAMES.get(key, (key, key))
            if not url.lower().startswith("http"):
                continue
            targets[key] = {"key": key, "name_ru": name_ru, "display_en": name_en, "url": url}
    out = list(targets.values())
    if ru:
        for t in out:
            t["url"] = t["url"].replace("yandex.com", "yandex.ru")
    return out


def main():
    p = argparse.ArgumentParser(description="Yandex multi-category via fixed URLs")
    p.add_argument("--urls", default="urls.txt", help="file with one fixed URL per category")
    p.add_argument("--only", nargs="+", help="only these keys (e.g. school pharmacy)")
    p.add_argument("--headless", dest="headless", action="store_true")
    p.add_argument("--no-headless", dest="headless", action="store_false")
    p.set_defaults(headless=False)
    p.add_argument("--ru", action="store_true", help="rewrite domain to yandex.ru")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--captcha-wait", type=int, default=180)
    p.add_argument("--max-stalls", type=int, default=8)
    p.add_argument("--no-org-coords", action="store_true")
    args, _ = p.parse_known_args()

    targets = load_targets(args.urls, args.ru)
    if args.only:
        targets = [t for t in targets if t["key"] in args.only]

    print("=== YANDEX MULTI (fixed URLs, schools-style) ===")
    if not targets:
        print("No targets. Put URLs in urls.txt or use built-in 'school'.")
        return
    for t in targets:
        print(f"  {t['name_ru']:<18} [{t['key']}] {t['url']}")

    with open("links_multi_tyumen.txt", "w", encoding="utf-8") as f:
        for t in targets:
            f.write(f"# {t['name_ru']} ({t['key']})\n{t['url']}\n\n")

    if args.dry_run:
        print("\nDry-run OK. Remove --dry-run to scrape.")
        return

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Need: pip install playwright && playwright install chromium")
        return

    out_csv = "results_multi_tyumen.csv"
    out_json = "results_multi_tyumen.json"
    fieldnames = ["category_key", "query_ru", "display_en", "title", "address",
                  "lat", "lon", "rating", "org_url"]
    results = []

    def flush():
        Path(out_json).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        if results:
            with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=fieldnames)
                w.writeheader(); w.writerows(results)

    with sync_playwright() as sp:
        browser = sp.chromium.launch(
            headless=args.headless, args=["--disable-blink-features=AutomationControlled"])
        context = browser.new_context(
            locale="ru-RU", viewport={"width": 1360, "height": 900},
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"))
        page = context.new_page()
        page.set_default_navigation_timeout(45000)

        for i, t in enumerate(targets, 1):
            domain = domain_of(t["url"])
            print(f"\n[{i}/{len(targets)}] {t['name_ru']}")
            try:
                page.goto(t["url"], wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(2500)
            except Exception as e:
                print(f"  goto failed: {e}"); continue

            if looks_like_captcha(page):
                if args.headless:
                    print("  ⚠ captcha + headless — re-run without --headless."); continue
                print(f"  ⚠ captcha — solve it. Waiting up to {args.captcha_wait}s...")
                waited = 0
                while looks_like_captcha(page) and waited < args.captcha_wait:
                    time.sleep(3); waited += 3
                if looks_like_captcha(page):
                    print("  still captcha, skipping category."); continue
                print("  captcha cleared.")

            scroll_to_bottom(page, max_stalls=args.max_stalls)

            coord_index = {}
            try:
                coord_index = build_coord_index_from_html(page.content())
            except Exception:
                pass

            rows = parse_cards(page, domain, coord_index)
            print(f"  cards parsed: {len(rows)}")

            n = 0; new_rows = []; seen = set()
            for r in rows:
                key = r["org_id"] or r["org_url"]
                if not key or key in seen or not r["title"]:
                    continue
                seen.add(key); new_rows.append(r); n += 1
            print(f"  accepted {n}")

            if not args.no_org_coords:
                missing = [r for r in new_rows if not r["lat"] and r["org_url"]]
                if missing:
                    print(f"  fetching coords for {len(missing)} orgs without coords...")
                    for j, r in enumerate(missing, 1):
                        la, lo = fetch_coords_for_org(context, r["org_url"])
                        if la:
                            r["lat"], r["lon"] = la, lo
                        if j % 10 == 0:
                            print(f"    coords {j}/{len(missing)}", end="\r", flush=True)
                        time.sleep(0.4)
                    got = sum(1 for r in new_rows if r["lat"])
                    print(f"  coords resolved: {got}/{len(new_rows)}                 ")

            for r in new_rows:
                results.append({
                    "category_key": t["key"],
                    "query_ru": t["name_ru"],
                    "display_en": t["display_en"],
                    "title": r["title"],
                    "address": r["address"],
                    "lat": r["lat"],
                    "lon": r["lon"],
                    "rating": r["rating"],
                    "org_url": r["org_url"],
                })
            flush()

        browser.close()

    flush()
    if results:
        with_coords = sum(1 for r in results if r["lat"])
        print(f"\n✓ {len(results)} rows total  ({with_coords} with coordinates)")
        keys = []
        for r in results:
            if r["category_key"] not in keys:
                keys.append(r["category_key"])
        for k in keys:
            print(f"    {k:<16} {sum(1 for r in results if r['category_key']==k)}")
        print(f"CSV : {out_csv}")
        print(f"JSON: {out_json}")
    else:
        print("\n0 rows – likely captcha / empty. Keep headed; check your URLs in urls.txt.")


if __name__ == "__main__":
    main()
