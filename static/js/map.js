/**
 * map.js - OPTIMIZED + FIXED BEARING + CLICKABLE LINKS
 * 1. OSM парсинг ускорен (бэкенд) + кэш на фронте (избегаем повторных запросов в радиусе 50м)
 * 2. Клик на метры теперь поворачивает правильно: 3D yaw = 180 - bearing, + точный расчет через worldX/Z
 * 3. Все ссылки в сводке кликабельны: OSM -> Яндекс Карты по координатам
 */

(function () {
  "use strict";

  const appEl = document.getElementById("app");
  const isAdmin = appEl.dataset.isAdmin === "true";

  let aeroRen = null;
  let currentViewMode = "3d";

  let addModeActive = false;
  let pendingCoords = null;

  const LANG = {
    ru: { appTitle:"Точки с панорамами", adminLogin:"Вход для администратора", btnAddPoint:"Добавить точку", btnClose:"Закрыть", loadingPanorama:"Загрузка панорамы…", loading3d:"Загрузка 3D сцены…", searching:"Ищем панораму рядом…", notfound:"Панорама не найдена", clickMap:"Кликните по карте…", currentLoc:"Текущее местоположение" },
    en: { appTitle:"Panorama Points", adminLogin:"Admin login", btnAddPoint:"Add point", btnClose:"Close", loadingPanorama:"Loading panorama…", loading3d:"Loading 3D scene…", searching:"Searching panorama…", notfound:"Panorama not found", clickMap:"Click on map…", currentLoc:"Current location" },
  };

  const langRuBtn = document.getElementById("btn-lang-ru");
  const langEnBtn = document.getElementById("btn-lang-en");
  let currentLang = (localStorage.getItem("lang") || "ru").toLowerCase();
  if (currentLang !== "en" && currentLang !== "ru") currentLang = "ru";

  function getI18n(key) {
    const t = LANG[currentLang];
    switch (key) {
      case "currentLocation": return currentLang==="en"?"Current location":"Текущее местоположение";
      case "close": return t.btnClose;
      case "deletePoint": return currentLang==="en"?"Delete point":"Удалить точку";
      case "appTitle": return t.appTitle;
      case "adminLoginTitle": return currentLang==="en"?"Admin login":"Вход администратора";
      case "login": return currentLang==="en"?"Login":"Войти";
      case "cancel": return currentLang==="en"?"Cancel":"Отмена";
      default: return "";
    }
  }

  function setLang(lang) {
    currentLang = lang === "en" ? "en" : "ru";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const value = getI18n(key);
      if (value) el.textContent = value;
    });
    localStorage.setItem("lang", currentLang);
    if (langRuBtn) langRuBtn.classList.toggle("active", currentLang==="ru");
    if (langEnBtn) langEnBtn.classList.toggle("active", currentLang==="en");
    const t = LANG[currentLang];
    const adminStatusEl = document.getElementById("admin-status");
    if (adminStatusEl && currentLang==="en") {
      const isAdminNow = appEl.dataset.isAdmin==="true";
      adminStatusEl.textContent = isAdminNow ? "Admin mode: enabled" : "Admin mode: disabled";
    }
    const titleEl = document.getElementById("app-title");
    if (titleEl) titleEl.textContent = t.appTitle;
    const loginBtn = document.getElementById("btn-login");
    if (loginBtn) loginBtn.textContent = t.adminLogin;
    const addModeBtn = document.getElementById("btn-add-mode");
    if (addModeBtn && !addModeActive) addModeBtn.textContent = t.btnAddPoint;
  }

  if (langRuBtn) langRuBtn.addEventListener("click", () => setLang("ru"));
  if (langEnBtn) langEnBtn.addEventListener("click", () => setLang("en"));
  setLang(currentLang);

  const centerAttr = appEl.dataset.mapCenter || "57.1509,65.5273";
  const [centerLat, centerLon] = centerAttr.split(",").map((v) => parseFloat(v.trim()));
const map = L.map("map").setView([centerLat, centerLon], 12);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, attribution:"© OpenStreetMap contributors" }).addTo(map);

  const markers = new Map();
  const airMarkers = new Map();

  function escapeHtml(str) { const div=document.createElement("div"); div.textContent=str||""; return div.innerHTML; }
  function _toRadians(deg) { return (deg*Math.PI)/180; }
  function _toDegrees(rad) { return (rad*180)/Math.PI; }
  function _normalizeAngle(deg) { return ((deg%360)+360)%360; }
  function computeBearing(lat1,lon1,lat2,lon2) {
    const phi1=_toRadians(lat1),phi2=_toRadians(lat2),dl=_toRadians(lon2-lon1);
    return _normalizeAngle(_toDegrees(Math.atan2(Math.sin(dl)*Math.cos(phi2),Math.cos(phi1)*Math.sin(phi2)-Math.sin(phi1)*Math.cos(phi2)*Math.cos(dl))));
  }
  function haversineM(lat1,lon1,lat2,lon2){
    const R=6371000;
    const dLat=_toRadians(lat2-lat1);
    const dLon=_toRadians(lon2-lon1);
    const a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(_toRadians(lat1))*Math.cos(_toRadians(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
    return R*c;
  }
  function latLonToLocal(originLat, originLon, targetLat, targetLon){
    const cosLat=Math.cos(_toRadians(originLat));
    const dx=(targetLon-originLon)*111320*cosLat;
    const dy=(targetLat-originLat)*111320;
    return {x:dx, z:dy};
  }
  function getBuildingCentroidLocal(building){
    if(!building || !building.ring || building.ring.length===0) return null;
    let sx=0, sy=0;
    const ring=building.ring;
    for(let i=0;i<ring.length;i++){ sx+=ring[i][0]; sy+=ring[i][1]; }
    return {x:sx/ring.length, z:sy/ring.length};
  }
  function findNearestBuilding(poiLat, poiLon, buildings, maxDist){
    maxDist=maxDist||60;
    let best=null, bestDist=Infinity;
    if(!buildings || !buildings.length) return null;
    for(let i=0;i<buildings.length;i++){
      const b=buildings[i];
      if(b._lat==null || b._lon==null) continue;
      const d=haversineM(poiLat, poiLon, b._lat, b._lon);
      if(d<bestDist && d<=maxDist){ bestDist=d; best=b; }
    }
    return best?{building:best, dist:bestDist}:null;
  }
  function yandexLinkByCoords(lat, lon, title){
    // Ссылка на Яндекс Карты по координатам - откроет карточку с отзывами/фото если объект там есть
    // Формат: https://yandex.ru/maps/?ll=lon,lat&pt=lon,lat,pm2rdm&z=18
    // pm2rdm - красная метка
    const ll = `${lon},${lat}`;
    // text для поиска по имени + координатам - помогает найти отзывы
    const text = title ? encodeURIComponent(title) : "";
    // Используем pt + ll, l=map
    return `https://yandex.ru/maps/?ll=${ll}&pt=${ll},pm2rdm&z=18&l=map`;
  }

  function addMarker(point) { const m=L.marker([point.lat,point.lon]).addTo(map); m.bindPopup("<b>"+escapeHtml(point.title)+"</b>"); m.on("click",()=>openViewModal(point)); markers.set(point.id,m); }
  function clearAirMarkers() { airMarkers.forEach((m)=>map.removeLayer(m)); airMarkers.clear(); }
  function addAirMarker(point) { const k=point.id||`${point.lat}_${point.lon}`; const m=L.marker([point.lat,point.lon]).addTo(map); m.bindPopup("<b>"+escapeHtml(point.title||"Аэропанорама")+"</b>"); m.on("click",()=>openAirPano(point)); airMarkers.set(k,m); }

  async function loadPoints() { const res=await fetch("/api/points"); const points=await res.json(); markers.forEach((m)=>map.removeLayer(m)); markers.clear(); points.forEach(addMarker); }
  async function loadAirPanoMarkers() { const b=map.getBounds(); try{const res=await fetch(`/api/sky-panoramas?bbox=${encodeURIComponent(b.getWest()+","+b.getSouth()+","+b.getEast()+","+b.getNorth())}`); const data=await res.json(); if(!data||data.status!=="ok")return; clearAirMarkers(); (data.points||[]).forEach(addAirMarker);}catch(e){} }

  function debounce(fn,delayMs){let t=null;return function(...args){if(t)clearTimeout(t);t=setTimeout(()=>fn.apply(this,args),delayMs);};}
  loadPoints(); loadAirPanoMarkers();
  map.on("moveend",debounce(()=>loadAirPanoMarkers(),500));

  var searchInput=document.getElementById("search-input");
  var searchResults=document.getElementById("search-results");
  var searchMarker=null;
  if(searchInput){
    var searchTimer=null;
    searchInput.addEventListener("input",function(){
      clearTimeout(searchTimer);
      var q=searchInput.value.trim();
      if(q.length<2){searchResults.style.display="none";return;}
      searchTimer=setTimeout(async function(){
        var center=map.getCenter();
        try{
          var r=await fetch("/api/search?q="+encodeURIComponent(q)+"&lat="+center.lat+"&lon="+center.lng+"&limit=5");
          var d=await r.json();
          if(!d.results||!d.results.length){searchResults.style.display="none";return;}
          searchResults.innerHTML="";
          d.results.forEach(function(item){
            var div=document.createElement("div");
            div.style.cssText="padding:8px 12px;cursor:pointer;color:#e7e9ee;font-size:13px;border-bottom:1px solid #2a2f3a";
            div.textContent=item.name.length>60?item.name.substring(0,60)+"\u2026":item.name;
            div.addEventListener("click",function(){
              map.setView([item.lat,item.lon],16);
              if(searchMarker)map.removeLayer(searchMarker);
              searchMarker=L.marker([item.lat,item.lon]).addTo(map).bindPopup("<b>"+escapeHtml(item.name)+"</b>").openPopup();
              searchResults.style.display="none";searchInput.value=item.name;
            });
            div.addEventListener("mouseenter",function(){div.style.background="rgba(77,141,255,0.15)";});
            div.addEventListener("mouseleave",function(){div.style.background="transparent";});
            searchResults.appendChild(div);
          });
          searchResults.style.display="block";
        }catch(e){}
      },400);
    });
    document.addEventListener("click",function(e){if(!e.target.closest("#search-input")&&!e.target.closest("#search-results"))searchResults.style.display="none";});
  }

  map.on("click",function(e){if(addModeActive)return;openAt(e.latlng.lat,e.latlng.lng,"Точка "+e.latlng.lat.toFixed(5)+", "+e.latlng.lng.toFixed(5),"");});

  const currentLocationBtn=document.getElementById("btn-current-location");
  if(currentLocationBtn)currentLocationBtn.addEventListener("click",()=>{
    if(!navigator.geolocation){alert("Геолокация не поддерживается.");return;}
    currentLocationBtn.disabled=true; currentLocationBtn.textContent=currentLang==="en"?"Locating\u2026":"Определяем\u2026";
    navigator.geolocation.getCurrentPosition(async(pos)=>{
      map.setView([pos.coords.latitude,pos.coords.longitude],16);
      currentLocationBtn.disabled=false; currentLocationBtn.textContent=currentLang==="en"?"Current location":"Текущее местоположение";
      try{await loadPoiSummaryForLatLon(pos.coords.latitude,pos.coords.longitude);}catch(_){}
      try{await loadAirPanoMarkers();}catch(_){}
    },(err)=>{console.warn("Geolocation error:",err);alert("Не удалось.");currentLocationBtn.disabled=false;currentLocationBtn.textContent=currentLang==="en"?"Current location":"Текущее местоположение";},{enableHighAccuracy:true,timeout:10000});
  });

  function showModal(id){document.getElementById(id).classList.remove("hidden");}
  function hideModal(id){document.getElementById(id).classList.add("hidden");}

  // ─────── POI СИСТЕМА ───────

  let currentPoiItems = [];
  let poiOverlay = null;
  let poiOverlayFrame = null;
  let poiCategoryIcons = {};

  let lastPanoMeta = null;
  let lastBuildings = [];
  let lastOSMOrigin = null;

  // Кэш фронта для OSM - избегаем повторных запросов в радиусе 50м
  let lastPoiFetch = {lat:null, lon:null, data:null, time:0};
  let lastBuildingsFetch = {lat:null, lon:null, data:null, time:0};

  async function loadPoiCategoryIcons() {
    try { const res = await fetch("/api/poi-icons"); poiCategoryIcons = await res.json(); } catch(e) { poiCategoryIcons = {}; }
  }
  loadPoiCategoryIcons();

  function clearPoiMarkers() { currentPoiItems = []; renderPoiOverlay([]); }

  function ensurePoiOverlay(container) {
    if (!container) return null;
    if (!poiOverlay || poiOverlay.parentNode !== container) {
      destroyPoiOverlay();
      poiOverlay = document.createElement("div");
      poiOverlay.className = "panorama-poi-overlay";
      poiOverlay.style.position = "absolute";
      poiOverlay.style.top = "0";
      poiOverlay.style.left = "0";
      poiOverlay.style.right = "0";
      poiOverlay.style.bottom = "0";
      poiOverlay.style.pointerEvents = "none";
      poiOverlay.style.zIndex = "12";
      container.appendChild(poiOverlay);
    }
    return poiOverlay;
  }

  function destroyPoiOverlay() {
    if (poiOverlayFrame) { cancelAnimationFrame(poiOverlayFrame); poiOverlayFrame = null; }
    if (poiOverlay && poiOverlay.parentNode) poiOverlay.parentNode.removeChild(poiOverlay);
    poiOverlay = null;
  }

  function renderPoiOverlay(items) {
    currentPoiItems = items || [];
    if (!poiOverlay) return;
    poiOverlay.innerHTML = "";
    currentPoiItems.forEach((item, index) => {
      if (item.bearing == null && item.worldX == null) return;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "pano-poi-marker";
      marker.style.position = "absolute";
      marker.style.pointerEvents = "auto";
      marker.style.padding = "0";
      marker.style.cursor = "pointer";
      marker.dataset.index = index;

      const iconUrl = poiCategoryIcons[item.category];
      const titleHtml = escapeHtml(item.title);
      const distM = item.dist_m != null && item.dist_m !== "" ? `${escapeHtml(String(item.dist_m))}м` : "";

      const tooltipHtml = `<span class="pano-poi-tooltip">${titleHtml}</span><span class="pano-poi-distance-always">${distM}</span>`;

      if (iconUrl) {
        marker.classList.add("pano-poi-marker--icon");
        marker.innerHTML = `<img class="pano-poi-icon" src="${iconUrl}" alt="" />${tooltipHtml}`;
      } else {
        marker.innerHTML = `<span class="pano-poi-dot"></span>${tooltipHtml}`;
      }

      // Передаем и bearing и item индекс для точного поворота
      marker.addEventListener("click", () => { focusPoiItem(index); });
      poiOverlay.appendChild(marker);
    });
    updatePoiOverlay();
    startPoiOverlayLoop();
  }

  function updatePoiOverlay() {
    if (!poiOverlay) return;

    let yawDeg, hfovDeg, pitchDeg;
    let use3D = false;
    if (currentViewMode === "3d" && aeroRen && aeroRen.cam) {
      yawDeg = _normalizeAngle(aeroRen.getYaw());
      hfovDeg = aeroRen.getHfov();
      pitchDeg = aeroRen.getPitch();
      use3D = true;
    } else if (viewViewer) {
      yawDeg = _normalizeAngle(viewViewer.getYaw());
      hfovDeg = viewViewer.getHfov();
      pitchDeg = typeof viewViewer.getPitch === "function" ? viewViewer.getPitch() : 0;
    } else {
      return;
    }

    const rect = poiOverlay.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;

    const hfov = _toRadians(hfovDeg);
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (height / width));
    const tanHalfV = Math.tan(vfov / 2);
    const margin = 20;

    if (use3D) {
      const T = window.THREE;
      if (!T || !aeroRen.cam) return;
      const cam = aeroRen.cam;
      try { cam.updateMatrixWorld(); cam.updateProjectionMatrix(); } catch(e){}
      const camPos = cam.position.clone();
      const camDir = new T.Vector3();
      try { cam.getWorldDirection(camDir); } catch(e){ camDir.set(0,0,-1); }

      Array.from(poiOverlay.children).forEach((marker) => {
        const index = Number(marker.dataset.index);
        const item = currentPoiItems[index];
        if (!item) { marker.style.display = "none"; return; }
        if (item.worldX == null || item.worldZ == null) { marker.style.display = "none"; return; }

        const target = new T.Vector3(item.worldX, item.targetHeight!=null?item.targetHeight:5, item.worldZ);
        const toPoint = new T.Vector3().subVectors(target, camPos);
        const dot = toPoint.dot(camDir);
        if (dot <= 0.5) { marker.style.display = "none"; return; }

        const ndc = target.clone().project(cam);
        if (ndc.z > 1 || ndc.z < -1) { marker.style.display="none"; return; }
        if (Math.abs(ndc.x) > 1.2 || Math.abs(ndc.y) > 1.2) { marker.style.display="none"; return; }

        const x = (ndc.x * 0.5 + 0.5) * width;
        const y = (-ndc.y * 0.5 + 0.5) * height;

        if (y <= margin || y >= height - margin || x <= margin || x >= width - margin) {
          if (Math.abs(ndc.x) > 0.98 || Math.abs(ndc.y) > 0.98) { marker.style.display="none"; return; }
        }

        marker.style.display = "block";
        marker.style.left = `${x}px`;
        marker.style.top = `${y}px`;
        marker.style.transform = marker.classList.contains("pano-poi-marker--icon") ? "translate(-50%, -100%)" : "translateX(-50%)";
        marker.style.opacity = dot < 20 ? "0.9" : "1";
      });
      return;
    }

    Array.from(poiOverlay.children).forEach((marker) => {
      const index = Number(marker.dataset.index);
      const item = currentPoiItems[index];
      if (!item || item.bearing == null) { marker.style.display = "none"; return; }

      let diff = item.bearing - yawDeg;
      diff = diff - 360 * Math.round(diff / 360);
      if (Math.abs(diff) > hfovDeg / 2 + 8) { marker.style.display = "none"; return; }
      const x = width / 2 + (diff / hfovDeg) * width;

      const itemPitch = (item.pitch != null && isFinite(item.pitch)) ? item.pitch : 0;
      const diffPitch = itemPitch - pitchDeg;
      const diffPitchRad = _toRadians(diffPitch);
      const ndcY = Math.tan(diffPitchRad) / tanHalfV;
      if (Math.abs(ndcY) > 1.15) { marker.style.display = "none"; return; }
      const y = height / 2 - (ndcY * height) / 2;
      if (y <= margin*0.5 || y >= height - margin*0.5) { marker.style.display = "none"; return; }

      marker.style.display = "block";
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      marker.style.transform = marker.classList.contains("pano-poi-marker--icon") ? "translate(-50%, -100%)" : "translateX(-50%)";
    });
  }

  function startPoiOverlayLoop() {
    if (poiOverlayFrame) return;
    const tick = () => { updatePoiOverlay(); poiOverlayFrame = requestAnimationFrame(tick); };
    tick();
  }

  // Исправленный поворот: для 3D конвертируем bearing -> yaw = 180 - bearing, либо точный расчет через worldX/Z
  function focusPoiItem(indexOrItem){
    let item = null;
    if (typeof indexOrItem === 'number'){
      item = currentPoiItems[indexOrItem];
    } else if (indexOrItem && typeof indexOrItem === 'object'){
      item = indexOrItem;
    }
    if (!item) return;

    if (currentViewMode === "3d" && aeroRen){
      let targetYaw;
      if (item.worldX != null && item.worldZ != null && aeroRen._camPos){
        const dx = item.worldX - aeroRen._camPos.x;
        const dz = item.worldZ - aeroRen._camPos.z;
        const bearingFromCam = _normalizeAngle(_toDegrees(Math.atan2(dx, dz)));
        targetYaw = _normalizeAngle(180 - bearingFromCam);
      } else if (item.bearing != null){
        targetYaw = _normalizeAngle(180 - item.bearing);
      } else {
        return;
      }
      aeroRen.setYaw(targetYaw, 700);
    } else if (viewViewer && typeof viewViewer.setYaw === "function"){
      const yaw = item.bearing!=null ? item.bearing : 0;
      viewViewer.setYaw(_normalizeAngle(yaw), 700);
      try {
        if (item.pitch!=null && typeof viewViewer.setPitch==="function"){
          viewViewer.setPitch(Math.max(-80, Math.min(30, item.pitch+5)), 400);
        }
      } catch(e){}
    }
  }

  // Для совместимости со старыми вызовами где передавался только угол
  function focusPoiYaw(angle, itemOrIndex){
    if (itemOrIndex!=null){
      focusPoiItem(itemOrIndex);
      return;
    }
    // найти item по bearing
    const item = currentPoiItems.find(it=> it && it.bearing!=null && Math.abs(_normalizeAngle(it.bearing)-_normalizeAngle(angle))<1.5);
    if (item){
      focusPoiItem(item);
    } else {
      // fallback
      if (currentViewMode === "3d" && aeroRen){
        aeroRen.setYaw(_normalizeAngle(180 - angle), 700);
      } else if (viewViewer){
        viewViewer.setYaw(_normalizeAngle(angle), 700);
      }
    }
  }

  function renderPoiSummary(data, centerPoint) {
    const poiEl = document.getElementById("poi-summary");
    if (!poiEl) return;
    clearPoiMarkers();
    if (!data || data.status !== "ok") { poiEl.innerHTML = `<p class="hint">${currentLang==="en"?"Summary unavailable":"Сводка недоступна"}</p>`; return; }
    const categories = (data.categories || []).filter((c) => (c.count || 0) > 0);
    if (!categories.length) { poiEl.innerHTML = `<p class="hint">В радиусе ${data.radius_m}м объектов не найдено</p>`; return; }
    poiEl.innerHTML = "";
    const panoActive = (currentViewMode==="pano" && lastPanoMeta && lastPanoMeta.pano_lat!=null);
    const baseLat = panoActive ? lastPanoMeta.pano_lat : (centerPoint?centerPoint.lat:null);
    const baseLon = panoActive ? lastPanoMeta.pano_lon : (centerPoint?centerPoint.lon:null);
    const panoH = (lastPanoMeta && lastPanoMeta.height!=null) ? lastPanoMeta.height : 150;
    const originForWorld = lastOSMOrigin || centerPoint;

    categories.forEach((cat) => {
      const count = cat.count || 0; const items = cat.items || [];
      const wrapper = document.createElement("div"); wrapper.className = "poi-category";
      const head = document.createElement("div"); head.className = "poi-category-head";
      const name = document.createElement("div"); name.className = "name"; name.textContent = cat.name;
      const c = document.createElement("div"); c.className = "count"; c.textContent = count;
      head.appendChild(name); head.appendChild(c);
      const list = document.createElement("div");
      if (!items.length) { const empty=document.createElement("p"); empty.className="hint"; empty.textContent=currentLang==="en"?"not found":"не найдено"; list.appendChild(empty); }
      else { items.forEach((it) => {
        const title = it.title || "Объект";
        const dist = it.dist_m != null ? it.dist_m : "";

        const nearest = findNearestBuilding(it.lat, it.lon, lastBuildings, 70);
        let targetLat = it.lat, targetLon = it.lon;
        let targetHeight = 2.5;
        let worldX=null, worldZ=null;
        let buildingForIcon = null;
        if (nearest) {
          targetLat = nearest.building._lat;
          targetLon = nearest.building._lon;
          targetHeight = (nearest.building.height||8) * 0.6;
          buildingForIcon = nearest.building;
          const centroid = getBuildingCentroidLocal(nearest.building);
          if (centroid) {
            worldX = centroid.x;
            worldZ = centroid.z;
          } else if (originForWorld) {
            const loc = latLonToLocal(originForWorld.lat, originForWorld.lon, targetLat, targetLon);
            worldX = loc.x; worldZ = loc.z;
          }
        } else {
          if (originForWorld) {
            const loc = latLonToLocal(originForWorld.lat, originForWorld.lon, it.lat, it.lon);
            worldX = loc.x; worldZ = loc.z;
          }
          targetHeight = 2;
        }

        let bearing = null;
        let pitch = null;
        let overlayDist = null;
        if (baseLat!=null && baseLon!=null && targetLat!=null && targetLon!=null) {
          bearing = computeBearing(baseLat, baseLon, targetLat, targetLon);
          overlayDist = haversineM(baseLat, baseLon, targetLat, targetLon);
          pitch = - Math.atan2(Math.max(1, panoH - targetHeight), Math.max(1, overlayDist)) * 180 / Math.PI;
          pitch = Math.max(-85, Math.min(15, pitch));
        } else if (centerPoint) {
          bearing = computeBearing(centerPoint.lat, centerPoint.lon, targetLat, targetLon);
        }

        const newItem = {
          category:cat.key,
          title,
          dist_m:dist,
          bearing,
          pitch,
          lat:targetLat,
          lon:targetLon,
          orig_lat:it.lat,
          orig_lon:it.lon,
          worldX,
          worldZ,
          targetHeight,
          overlayDist,
          building: buildingForIcon,
          org_url: it.org_url || "",
          source: it.source || (it.org_url ? "yandex" : "osm")
        };
        currentPoiItems.push(newItem);
        const itemIndex = currentPoiItems.length - 1;

        // Все ссылки кликабельны: если нет org_url (OSM) -> генерим яндекс по координатам
        let link = it.org_url && it.org_url.trim() !== "" ? it.org_url : yandexLinkByCoords(targetLat, targetLon, title);
        const titleHtml = `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer" title="${escapeHtml(link)}">${escapeHtml(title)}</a>`;

        const distSpan = document.createElement("span"); distSpan.className = "dist"; distSpan.textContent = `— ${dist}м`;
        if (bearing!=null) {
          distSpan.style.cursor="pointer";
          distSpan.style.color="var(--accent)";
          distSpan.addEventListener("click",()=> focusPoiItem(itemIndex));
          distSpan.title = "Повернуть панораму к объекту";
        }
        const p = document.createElement("div"); p.className = "poi-item"; p.innerHTML = titleHtml + " "; p.appendChild(distSpan);
        // иконка источника
        const srcBadge = document.createElement("span");
        srcBadge.style.cssText="font-size:10px;color:#6a7080;margin-left:4px";
        srcBadge.textContent = newItem.source==="osm" ? "OSM→Я" : "Я";
        p.appendChild(srcBadge);
        list.appendChild(p);
      }); }
      wrapper.appendChild(head); wrapper.appendChild(list); poiEl.appendChild(wrapper);
    });
    const overlayItems = [];
    const catCount = {};
    for (const item of currentPoiItems) {
      if (item.bearing == null && item.worldX==null) continue;
      catCount[item.category] = (catCount[item.category] || 0) + 1;
      if (catCount[item.category] <= 2) overlayItems.push(item);
    }
    if (centerPoint && overlayItems.length) renderPoiOverlay(overlayItems);
  }

  async function loadPoiSummaryForLatLon(lat, lon) {
    const poiEl = document.getElementById("poi-summary"); if (!poiEl) return;
    // Фронт-кэш: если запрос в радиусе 40м и не старше 2 мин - используем
    if (lastPoiFetch.lat!=null && haversineM(lat, lon, lastPoiFetch.lat, lastPoiFetch.lon) < 40 && (Date.now() - lastPoiFetch.time) < 120000 && lastPoiFetch.data){
      renderPoiSummary(lastPoiFetch.data, currentViewPoint);
      return;
    }
    poiEl.innerHTML = `<p class="hint">Ищем ближайшие объекты…</p>`;
    let data; try { const res=await fetch(`/api/poi-summary?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radius_m=500`); data=await res.json(); } catch(e) { poiEl.innerHTML=`<p class="hint">Не удалось получить сводку.</p>`; return; }
    lastPoiFetch = {lat, lon, data, time: Date.now()};
    renderPoiSummary(data, currentViewPoint);
  }

  let previewViewer = null;
  let viewViewer = null;

  function destroyAll() {
    if (previewViewer) { try{ previewViewer.destroy(); }catch(e){} previewViewer=null; }
    if (viewViewer) { try{ viewViewer.destroy(); }catch(e){} viewViewer=null; }
    if (aeroRen) { try{ aeroRen.destroy(); }catch(e){} aeroRen=null; }
    currentPoiItems = []; destroyPoiOverlay();
  }

  function showPanoramaFallback(containerId,url,statusEl,loadingEl) {
    const container=document.getElementById(containerId); if(!container)return null;
    container.innerHTML=""; const img=document.createElement("img"); img.src=url; img.alt="Панорама";
    img.style.cssText="width:100%;height:100%;object-fit:contain;display:block";
    img.addEventListener("load",()=>{statusEl.classList.add("hidden");if(loadingEl)loadingEl.classList.add("hidden");});
    img.addEventListener("error",()=>{statusEl.textContent="Не удалось загрузить панораму.";statusEl.classList.remove("hidden");if(loadingEl)loadingEl.classList.add("hidden");});
    container.appendChild(img); return {viewer:null,fallback:true};
  }

  async function loadPanoramaInto(containerId,statusElId,lat,lon,options={}) {
    const isMainView = containerId==="view-panorama";
    if (!isMainView){
      if (previewViewer) { try{ previewViewer.destroy(); }catch(e){} previewViewer=null; }
      if (viewViewer) { try{ viewViewer.destroy(); }catch(e){} viewViewer=null; }
      if (aeroRen) { try{ aeroRen.destroy(); }catch(e){} aeroRen=null; }
    }
    if (isMainView) destroyAll();

    const statusEl=document.getElementById(statusElId); const container=document.getElementById(containerId);
    const loadingElId=options.loadingElId||options.ld||null; const loadingEl=loadingElId?document.getElementById(loadingElId):null;
    if (container) { container.innerHTML=""; }
    ensurePoiOverlay(container);
    if(loadingEl)loadingEl.classList.remove("hidden");
    statusEl.textContent=currentLang==="en"?"Searching for panorama nearby…":"Ищем панораму рядом с точкой…"; statusEl.classList.remove("hidden");
    const params=new URLSearchParams({lat:String(lat),lon:String(lon)}); if(options.force)params.set("force","1");
    let data; try{const res=await fetch(`/api/panorama?${params.toString()}`);data=await res.json();}catch(err){statusEl.textContent="Не удалось связаться.";if(loadingEl)loadingEl.classList.add("hidden");return null;}
    if(data.status==="not_found"){statusEl.textContent="Рядом панорама не найдена.";if(loadingEl)loadingEl.classList.add("hidden");return null;}
    if(data.status==="error"){statusEl.textContent="Ошибка: "+(data.message||"");if(loadingEl)loadingEl.classList.add("hidden");return null;}
    statusEl.classList.add("hidden");if(loadingEl)loadingEl.classList.add("hidden");

    if (isMainView) {
      lastPanoMeta = {
        pano_lat: data.pano_lat!=null?data.pano_lat:lat,
        pano_lon: data.pano_lon!=null?data.pano_lon:lon,
        height: data.height!=null?data.height:150,
        url: data.url,
        name: data.name
      };
    }

    let viewer; try{viewer=pannellum.viewer(containerId,{type:"equirectangular",panorama:data.url,autoLoad:true,showControls:true,compass:false,autoRotate:false,useCanvas:true,hotSpots:[]});ensurePoiOverlay(container);}
    catch(err){console.warn("Pannellum failed",err);return showPanoramaFallback(containerId,data.url,statusEl,loadingEl);}
    const canvas=container.querySelector("canvas"); if(canvas)canvas.addEventListener("webglcontextlost",(e)=>{e.preventDefault();destroyAll();showPanoramaFallback(containerId,data.url,statusEl,loadingEl);});
    if(viewer&&typeof viewer.on==="function"){viewer.on("load",()=>{if(currentPoiItems.length)renderPoiOverlay(currentPoiItems);});viewer.on("error",()=>{destroyAll();showPanoramaFallback(containerId,data.url,statusEl,loadingEl);});}
    return {viewer,data};
  }

  async function switchTo(mode,lat,lon) {
    currentViewMode=mode;
    const b3=document.getElementById("btn-view-3d"),bp=document.getElementById("btn-view-pano");
    if(b3)b3.classList.toggle("active",mode==="3d");if(bp)bp.classList.toggle("active",mode==="pano");
    const ct=document.getElementById("view-panorama"),ld=document.getElementById("view-panorama-loading"),st=document.getElementById("view-panorama-status");
    if(mode!=="pano"){
      if (viewViewer) { try{ viewViewer.destroy(); }catch(e){} viewViewer=null; }
      if (aeroRen) { try{ aeroRen.destroy(); }catch(e){} aeroRen=null; }
      currentPoiItems = []; destroyPoiOverlay();
    }
    if(ct && mode==="3d")ct.innerHTML="";

    if(mode==="3d") {
      if(ld)ld.classList.remove("hidden");if(st){st.textContent=LANG[currentLang].loading3d;st.classList.remove("hidden");}
      // Оптимизация фронт-кэша зданий: если в радиусе 50м уже загружали - не дергаем бэк
      let buildData = null;
      const useCache = lastBuildingsFetch.lat!=null && haversineM(lat, lon, lastBuildingsFetch.lat, lastBuildingsFetch.lon) < 50 && (Date.now()-lastBuildingsFetch.time)<180000 && lastBuildingsFetch.data;
      if (useCache){
        buildData = lastBuildingsFetch.data;
      } else {
        const radius=300;
        try{const res=await fetch("/api/osm-buildings?lat="+encodeURIComponent(lat)+"&lon="+encodeURIComponent(lon)+"&radius_m="+radius);buildData=await res.json();if(buildData.status==="error")throw new Error(buildData.message);}
        catch(e){if(st){st.textContent="Ошибка: "+e.message;st.classList.remove("hidden");}if(ld)ld.classList.add("hidden");return;}
        lastBuildingsFetch = {lat,lon,data:buildData,time:Date.now()};
      }

      let camX=0,camZ=0;
      if(buildData.buildings&&buildData.buildings.length>0){
        const nearest=buildData.buildings[0]; const ring=nearest.ring;
        let cx=0,cy=0; for(let i=0;i<ring.length;i++){cx+=ring[i][0];cy+=ring[i][1];}
        camX=cx/ring.length; camZ=cy/ring.length;
      }

      lastBuildings = buildData.buildings || [];
      lastOSMOrigin = {lat:lat, lon:lon};

      const el=document.getElementById("view-panorama"); if(el) el.innerHTML="";
      const ar=new window.AeroRenderer(el,{bg:0x87CEEB,ground:0x73787b,fov:75});
      if(!ar.init()){if(st){st.textContent="WebGL не поддерживается";st.classList.remove("hidden");}if(ld)ld.classList.add("hidden");return;}
      ar.load(buildData,camX,camZ); ar.start(); aeroRen=ar;
      if(ld)ld.classList.add("hidden");if(st)st.classList.add("hidden");
      ensurePoiOverlay(ct);
      startPoiOverlayLoop();
      loadPoiSummaryForLatLon(lat,lon);

      ar.onBuildingClick=function(bData){
        if(isAdmin){showPlanAdmin(bData);}
        else if(bData.plan){showPlanViewer(bData.plan);}
      };

    } else {
      if(ld)ld.classList.remove("hidden");
      const res=await loadPanoramaInto("view-panorama","view-panorama-status",lat,lon,{loadingElId:"view-panorama-loading"});
      if(res){
        viewViewer=res.viewer;
        ensurePoiOverlay(ct);
        startPoiOverlayLoop();
        loadPoiSummaryForLatLon(lat,lon);
      }
    }
  }

  let currentViewPoint = null;

  function openAt(lat,lon,title,desc,pid) {
    currentViewPoint={lat:lat,lon:lon,title:title,description:desc||"",id:pid};
    document.getElementById("view-point-title").textContent=title;
    document.getElementById("view-point-description").textContent=desc||"";
    const ld=document.getElementById("view-panorama-loading"),st=document.getElementById("view-panorama-status"),ct=document.getElementById("view-panorama");
    if(ct)ct.innerHTML="";if(ld)ld.classList.remove("hidden");if(st){st.textContent="";st.classList.remove("hidden");}
    showModal("view-point-modal");
    const tg=document.getElementById("aero-view-toggle");if(tg)tg.style.display="flex";
    switchTo("3d",lat,lon);
  }

  function openViewModal(point) { openAt(point.lat,point.lon,point.title,point.description||"",point.id); }

  function openAirPano(panoPoint) {
    openAt(panoPoint.lat,panoPoint.lon,panoPoint.title||"Воздушная панорама",panoPoint.description||"");
  }

  const b3d=document.getElementById("btn-view-3d"),bpo=document.getElementById("btn-view-pano");
  if(b3d)b3d.addEventListener("click",()=>{if(currentViewPoint)switchTo("3d",currentViewPoint.lat,currentViewPoint.lon);});
  if(bpo)bpo.addEventListener("click",()=>{if(currentViewPoint)switchTo("pano",currentViewPoint.lat,currentViewPoint.lon);});

  document.querySelectorAll(".js-close-modal").forEach((btn)=>{btn.addEventListener("click",(e)=>{const modal=e.target.closest(".modal");modal.classList.add("hidden");destroyAll();});});

  const reloadBtn=document.getElementById("view-point-reload");
  if(reloadBtn)reloadBtn.addEventListener("click",async()=>{if(!currentViewPoint||currentViewPoint.lat==null)return;
    // сброс фронт-кэша
    lastPoiFetch = {lat:null,lon:null,data:null,time:0};
    lastBuildingsFetch = {lat:null,lon:null,data:null,time:0};
    switchTo(currentViewMode,currentViewPoint.lat,currentViewPoint.lon);});

  const deleteBtn=document.getElementById("view-point-delete");
  if(deleteBtn)deleteBtn.addEventListener("click",async()=>{if(!currentViewPoint)return;if(!confirm(`Удалить точку "${currentViewPoint.title}"?`))return;await fetch(`/api/points/${currentViewPoint.id}`,{method:"DELETE"});hideModal("view-point-modal");destroyAll();loadPoints();});

  const loginBtn=document.getElementById("btn-login");
  if(loginBtn)loginBtn.addEventListener("click",()=>{document.getElementById("login-error").classList.add("hidden");document.getElementById("login-password").value="";showModal("login-modal");});
  const loginSubmit=document.getElementById("login-submit");
  if(loginSubmit)loginSubmit.addEventListener("click",async()=>{const password=document.getElementById("login-password").value;const res=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});const data=await res.json();if(data.ok)location.reload();else{const err=document.getElementById("login-error");err.textContent=data.error||"Ошибка входа";err.classList.remove("hidden");}});
  const logoutBtn=document.getElementById("btn-logout");
  if(logoutBtn)logoutBtn.addEventListener("click",async()=>{await fetch("/api/logout",{method:"POST"});location.reload();});

  const addModeBtn=document.getElementById("btn-add-mode");
  if(addModeBtn){const t=LANG[currentLang];if(!addModeActive)addModeBtn.textContent=t.btnAddPoint;
    addModeBtn.addEventListener("click",()=>{addModeActive=!addModeActive;addModeBtn.classList.toggle("active",addModeActive);addModeBtn.textContent=addModeActive?"Кликните по карте…":"Добавить точку";});}
  if(isAdmin){map.on("click",(e)=>{if(!addModeActive)return;pendingCoords={lat:e.latlng.lat,lon:e.latlng.lng};openAddPointModal(pendingCoords);addModeActive=false;addModeBtn.classList.remove("active");addModeBtn.textContent="Добавить точку";});}
  async function openAddPointModal(coords){
    document.getElementById("add-point-coords").textContent=`${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)}`;
    document.getElementById("add-point-title").value="";document.getElementById("add-point-description").value="";
    showModal("add-point-modal");
    const result=await loadPanoramaInto("panorama-preview","panorama-status",coords.lat,coords.lon);
    if(result)previewViewer=result.viewer;
  }
  const addPointSubmit=document.getElementById("add-point-submit");
  if(addPointSubmit)addPointSubmit.addEventListener("click",async()=>{if(!pendingCoords)return;const title=document.getElementById("add-point-title").value.trim();const description=document.getElementById("add-point-description").value.trim();
    await fetch("/api/points",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat:pendingCoords.lat,lon:pendingCoords.lon,title,description})});hideModal("add-point-modal");destroyAll();pendingCoords=null;loadPoints();});

  function showPlanAdmin(bData){
    var info=document.getElementById("plan-info");
    var uploadBtn=document.getElementById("plan-upload-btn");
    var removeBtn=document.getElementById("plan-remove-btn");
    var fileInput=document.getElementById("plan-file-input");
    var btype=bData.type||"здание";var bname=bData.name||"";
    info.innerHTML="<b>"+escapeHtml(bname||btype)+"</b><br>Тип: "+escapeHtml(btype)+"<br>Высота: "+(bData.height||"?")+"м";
    if(bData.plan){
      removeBtn.style.display="inline-block";uploadBtn.textContent="Заменить план";
      removeBtn.onclick=function(){
        fetch("/api/plans/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat:bData._lat,lon:bData._lon})}).then(function(){hideModal("plan-modal");switchTo("3d",currentViewPoint.lat,currentViewPoint.lon);});
      };
    }else{removeBtn.style.display="none";uploadBtn.textContent="Загрузить план";}
    uploadBtn.onclick=function(){fileInput.click();};
    fileInput.onchange=function(){
      var file=fileInput.files[0];if(!file)return;
      var fd=new FormData();fd.append("file",file);
      fd.append("lat",bData._lat||0);fd.append("lon",bData._lon||0);
      fetch("/api/plans/upload",{method:"POST",body:fd}).then(function(){hideModal("plan-modal");switchTo("3d",currentViewPoint.lat,currentViewPoint.lon);});
    };
    showModal("plan-modal");
  }
  function showPlanViewer(filename){
    var ov=document.getElementById("plan-viewer-overlay");
    document.getElementById("plan-viewer-img").src="/plans/"+filename;
    ov.style.display="flex";
  }
  var planOv=document.getElementById("plan-viewer-overlay");
  if(planOv)planOv.addEventListener("click",function(e){if(e.target===planOv)planOv.style.display="none";});
  var planCancelBtn=document.getElementById("plan-cancel-btn");
  if(planCancelBtn)planCancelBtn.addEventListener("click",function(){hideModal("plan-modal");});
})();
