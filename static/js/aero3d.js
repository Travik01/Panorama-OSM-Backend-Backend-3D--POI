/**
 * aero3d.js — Аэро-панорама из OSM + планы этажей
 * Камера: FIRST-PERSON (как Pannellum)
 */
(function(){
"use strict";

class AeroRenderer{
  constructor(el,opts){
    this.el=el;
    this.o=Object.assign({bg:0x87CEEB,ground:0x73787b,fov:75},opts||{});
    this.scene=this.cam=this.ren=this.group=this.roadGroup=this.roadMarkingGroup=this.greenGroup=this.treeGroup=this.waterGroup=this.ground=null;
    this.raf=null; this.dead=false;
    this.yaw=0; this.pitch=-20;
    this._dragging=false; this._lastMX=0; this._lastMY=0;
    this._clickStartX=0; this._clickStartY=0;
    this._resize=this._resize.bind(this); this._frame=this._frame.bind(this);
    // Plans + building click
    this._buildings=[];
    this._buildingMeshes=[];
    this._plans=[];
this._raycaster=null;
    this._mouse=new THREE.Vector2();
    this.onBuildingClick=null;
this._facadeCache={};
    this._roofCache={};
    this._groundCache=null;
    this._sidewalkGroup=null;
    this._lampGroup=null;
    this._crosswalkGroup=null;
    this._carGroup=null;
    this._bushGroup=null;
  }

  _osmShape(ring){
    // ShapeGeometry/ExtrudeGeometry лежат в XY, а сцена — в XZ. После
    // rotateX(-PI/2) координата shape.y становится -world.z, поэтому знак
    // компенсируется здесь один раз для зданий, парков и воды.
    var shape=new this.T.Shape();
    shape.moveTo(ring[0][0],-ring[0][1]);
    for(var i=1;i<ring.length;i++)shape.lineTo(ring[i][0],-ring[i][1]);
shape.closePath();
    return shape;
  }

  _randomPointInPoly(poly){
    if(!poly||poly.length<3)return null;
    var minx=Infinity,maxx=-Infinity,miny=Infinity,maxy=-Infinity;
    for(var i=0;i<poly.length;i++){minx=Math.min(minx,poly[i][0]);maxx=Math.max(maxx,poly[i][0]);miny=Math.min(miny,poly[i][1]);maxy=Math.max(maxy,poly[i][1]);}
    for(var tries=0;tries<30;tries++){
      var px=minx+Math.random()*(maxx-minx);
      var py=miny+Math.random()*(maxy-miny);
      if(this._pointInPoly(px,py,poly))return [px,py];
    }
    // fallback: центроид
    var cx=0,cy=0;for(var k=0;k<poly.length;k++){cx+=poly[k][0];cy+=poly[k][1];}
    return [cx/poly.length,cy/poly.length];
  }
  _pointInPoly(px,py,poly){
    var inside=false,j=poly.length-1;
    for(var i=0;i<poly.length;i++){
      var xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
      if(((yi>py)!=(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;
      j=i;
    }
    return inside;
  }

  // ─────────────────────────────────────────────────────────────
  // Процедурные бесшовные фасады зданий (canvas → CanvasTexture)
  // Текстура тайлится (RepeatWrapping) по реальному масштабу, поэтому
  // стыки между повторами не видны.
  // ─────────────────────────────────────────────────────────────

  _hex(c){var t=this.T;return new t.Color(c);}
  _cacheKey(type,color){return type+"|"+(color||"");}

  _makeFacadeTexture(type,colorHex){
    var TW=256,TH=256;
    var t=this.T;
    // базовый цвет здания
    var base=new t.Color(colorHex||0xD4B896);
    // вариация: светлее/темнее в зависимости от типа
    var wallCol=new t.Color(base);
    var frameCol=new t.Color();frameCol.copy(base).multiplyScalar(0.55);
    var winCol=type==="industrial"||type==="warehouse"?new t.Color(0x9fb4c8):new t.Color(0x20303f);
    var winGlass=type==="commercial"||type==="office"||type==="retail"||type==="hotel";
    var c=document.createElement("canvas");c.width=TW;c.height=TH;
    var ctx=c.getContext("2d");

    var repeatX=TW/64, repeatY=TH/64; // графический тайл 64x64, повторяется 4x4 по канвасу
    // Заполняем фон стены
    ctx.fillStyle="rgb("+(wallCol.r*255|0)+","+(wallCol.g*255|0)+","+(wallCol.b*255|0)+")";
    ctx.fillRect(0,0,TW,TH);

    // лёгкий шум/зерно, чтобы не было "пластика"
    for(var n=0;n<900;n++){
      var g=Math.random();
      var shade=Math.random()*14-7;
      ctx.fillStyle="rgba("+((wallCol.r*255+shade)|0)+","+((wallCol.g*255+shade)|0)+","+((wallCol.b*255+shade)|0)+","+(g*0.25)+")";
      ctx.fillRect(Math.random()*TW,Math.random()*TH,1,1);
    }

    function windowRow(y,rowWin,winW,winH,winGap,winInset){
      var total=rowWin*winW+(rowWin-1)*winGap;
      var startX=(TW-total)/2;
      for(var i=0;i<rowWin;i++){
        var x=startX+i*(winW+winGap);
        // подоконник/рамка
        ctx.fillStyle="rgb("+(frameCol.r*255|0)+","+(frameCol.g*255|0)+","+(frameCol.b*255|0)+")";
        ctx.fillRect(x-winInset,y-winInset,winW+winInset*2,winH+winInset*2);
        // стекло / тёмный проём
        if(winGlass){
          var grd=ctx.createLinearGradient(x,y,x+winW,y+winH);
          grd.addColorStop(0,"rgba(120,170,220,0.85)");
          grd.addColorStop(0.5,"rgba(60,100,160,0.9)");
          grd.addColorStop(1,"rgba(30,60,110,0.95)");
          ctx.fillStyle=grd;
        }else{
          ctx.fillStyle="rgb("+(winCol.r*255|0)+","+(winCol.g*255|0)+","+(winCol.b*255|0)+")";
        }
        ctx.fillRect(x,y,winW,winH);
        // блик стекла
        if(winGlass){
          ctx.fillStyle="rgba(255,255,255,0.18)";
          ctx.fillRect(x+2,y+2,winW*0.35,winH*0.3);
        }
      }
    }

    // определяем раскладку по типу
    var rows,rowWin,winGap,winH,winW,winInset;
    if(type==="commercial"||type==="office"||type==="retail"||type==="hotel"){
      // стеклянный фасад: большие окна
      rows=3;rowWin=3;winGap=14;winH=38;winW=60;winInset=4;
      wallCol.lerp(new t.Color(0x9fb4c8),0.35);
    }else if(type==="industrial"||type==="warehouse"){
      // промышленный: мало маленьких окон + металл
      rows=2;rowWin=2;winGap=40;winH=26;winW=34;winInset=3;
      wallCol.lerp(new t.Color(0x8a8f96),0.4);
      // горизонтальные полосы металла
      ctx.strokeStyle="rgba(0,0,0,0.12)";
      ctx.lineWidth=2;
      for(var hy=16;hy<TH;hy+=32){ctx.beginPath();ctx.moveTo(0,hy);ctx.lineTo(TW,hy);ctx.stroke();}
    }else if(type==="school"||type==="hospital"){
      rows=3;rowWin=3;winGap=16;winH=34;winW=52;winInset=4;
    }else{
      // жилой: частые окна
      rows=4;rowWin=3;winGap=10;winH=30;winW=44;winInset=4;
    }

    // вертикальные панели между окнами (панельный дом)
    ctx.strokeStyle="rgba(0,0,0,0.10)";
    ctx.lineWidth=2;
    var colGap=TW/3;
    for(var px=colGap;px<TW;px+=colGap){ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,TH);ctx.stroke();}

var rowH=TH/(rows+0.5);
    for(var r=0;r<rows;r++)windowRow(r*rowH+rowH*0.35,rowWin,winW,winH,winGap,winInset);

    // ★ Балконы для жилых зданий (панель/жилой тип)
    if(type==="residential"||type==="apartments"||type==="house"){
      var balCol=new t.Color(frameCol);balCol.lerp(new t.Color(0xffffff),0.35);
      ctx.fillStyle="rgb("+(balCol.r*255|0)+","+(balCol.g*255|0)+","+(balCol.b*255|0)+")";
      for(var br=0;br<rows;br++){
        var by=br*rowH+rowH*0.35+winH+winInset+1;
        var total=rowWin*winW+(rowWin-1)*winGap;
        var bstart=(TW-total)/2;
        for(var bi=0;bi<rowWin;bi++){
          var bx=bstart+bi*(winW+winGap);
          // горизонтальная плита балкона
          ctx.fillRect(bx-winInset-2,by,winW+winInset*2+4,3);
          // вертикальные перила
          ctx.fillStyle="rgba("+(balCol.r*255|0)+","+(balCol.g*255|0)+","+(balCol.b*255|0)+",0.9)";
          for(var rail=0;rail<4;rail++){
            var rx=bx+winInset+1+(winW-winInset*2-2)*rail/3;
            ctx.fillRect(rx,by+3,2,5);
          }
        }
      }
      ctx.fillStyle="rgb("+(balCol.r*255|0)+","+(balCol.g*255|0)+","+(balCol.b*255|0)+")";
    }

    // ★ Тёмный цоколь (первый этаж) для всех зданий
    ctx.fillStyle="rgba(0,0,0,0.18)";
    ctx.fillRect(0,TH-22,TW,22);
    ctx.fillStyle="rgba(255,255,255,0.06)";
    ctx.fillRect(0,TH-22,TW,1);

    // лёгкое затемнение по краям канваса — чтобы повтор был незаметен
    var tex=new t.CanvasTexture(c);
    tex.wrapS=t.RepeatWrapping;tex.wrapT=t.RepeatWrapping;
    tex.repeat.set(1,1);
    tex.encoding=t.sRGBEncoding;
    tex.anisotropy=4;
    return tex;
  }

_makeRoofTexture(colorHex){
    var TW=256,TH=256;
    var t=this.T;
    var base=new t.Color(colorHex||0xffffff).multiplyScalar(0.8);
    var c=document.createElement("canvas");c.width=TW;c.height=TH;
    var ctx=c.getContext("2d");
    ctx.fillStyle="rgb("+(base.r*255|0)+","+(base.g*255|0)+","+(base.b*255|0)+")";
    ctx.fillRect(0,0,TW,TH);
    // рубероид/плитка: прямоугольники
    ctx.strokeStyle="rgba(0,0,0,0.18)";
    ctx.lineWidth=2;
    for(var y=0;y<TH;y+=16){
      ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(TW,y);ctx.stroke();
      for(var x=(y%32);x<TW;x+=32){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y+16);ctx.stroke();}
    }
    // шум
    for(var n=0;n<500;n++){
      var g=Math.random();
      ctx.fillStyle="rgba("+(255*Math.random()>0.5?0:0)+","+0+","+0+","+(g*0.08)+")";
      ctx.fillRect(Math.random()*TW,Math.random()*TH,1,1);
    }
    var tex=new t.CanvasTexture(c);
    tex.wrapS=t.RepeatWrapping;tex.wrapT=t.RepeatWrapping;
    tex.encoding=t.sRGBEncoding;
    return tex;
  }

  // ★ Крыша по реальной форме из OSM (roof:shape) — строится как геометрия
  _makeRoofGeometry(shape, roofShape, height, roofH){
    var T=this.T;
    var geo;
    if(roofShape==="gabled"||roofShape==="hipped"||roofShape==="skillion"||roofShape==="gambrel"||roofShape==="mansard"||roofShape==="pyramidal"){
      // Двускатная/вальмовая — вытянутый конус по главной оси
      var rh = roofH!=null?roofH:Math.max(1.5,height*0.25);
      var ext=new T.ExtrudeGeometry(shape,{depth:Math.max(0.5,rh),bevelEnabled:false,curveSegments:1});
      ext.rotateX(-Math.PI/2);
      // смещаем по локальной Y вверх, чтобы поверх стены
      ext.translate(0,0,0);
      geo=ext;
    }else if(roofShape==="conical"||roofShape==="dome"){
      // Коническая/купольная — лень точно, используем вытянутый конус аппроксимацией
      var rh2 = roofH!=null?roofH:Math.max(1.5,height*0.25);
      var ext2=new T.ExtrudeGeometry(shape,{depth:Math.max(0.5,rh2),bevelEnabled:false,curveSegments:1});
      ext2.rotateX(-Math.PI/2);
      geo=ext2;
    }else{
      // flat — плоская крыша как раньше
      geo=new T.ShapeGeometry(shape);
      geo.rotateX(-Math.PI/2);
    }
    return geo;
  }

_makeGroundTexture(){
    if(this._groundCache)return this._groundCache;
    var TW=512,TH=512;
    var t=this.T;
    var c=document.createElement("canvas");c.width=TW;c.height=TH;
    var ctx=c.getContext("2d");
    // базовый асфальт/бетон
    var base=55+Math.random()*8|0;
    ctx.fillStyle="rgb("+base+","+base+","+base+")";
    ctx.fillRect(0,0,TW,TH);
    // зерно
    for(var n=0;n<4000;n++){
      var sh=Math.random()*22-11;
      ctx.fillStyle="rgba("+((base+sh)|0)+","+((base+sh)|0)+","+((base+sh)|0)+","+(0.3+Math.random()*0.4)+")";
      ctx.fillRect(Math.random()*TW,Math.random()*TH,1+Math.random()*1.5,1+Math.random()*1.5);
    }
    // трещины / пятна
    ctx.strokeStyle="rgba(0,0,0,0.10)";
    for(var cr=0;cr<14;cr++){
      ctx.lineWidth=Math.random()*1.5+0.5;
      ctx.beginPath();
      var cx=Math.random()*TW,cy=Math.random()*TH;
      ctx.moveTo(cx,cy);
      for(var s=0;s<6;s++){cx+=Math.random()*60-30;cy+=Math.random()*60-30;ctx.lineTo(cx,cy);}
      ctx.stroke();
    }
    var tex=new t.CanvasTexture(c);
    tex.wrapS=t.RepeatWrapping;tex.wrapT=t.RepeatWrapping;
    tex.repeat.set(8,8);
    tex.encoding=t.sRGBEncoding;tex.anisotropy=4;
    this._groundCache=tex;
    return tex;
  }

  _getFacadeTexture(type,color){
    var key=this._cacheKey(type,color);
    if(this._facadeCache[key])return this._facadeCache[key];
    var tex=this._makeFacadeTexture(type,color);
    this._facadeCache[key]=tex;
    return tex;
  }
  _getRoofTexture(color){
    var key="roof|"+(color||"");
    if(this._roofCache[key])return this._roofCache[key];
    var tex=this._makeRoofTexture(color);
    this._roofCache[key]=tex;
    return tex;
  }

  // Строит стены здания как отдельную геометрию с UV-тайлингом,
  // чтобы текстура повторялась без видимых стыков.
  // Возвращает BufferGeometry (XZ-плоскость, стены вертикальные).
  _buildWallGeometry(ring,height){
    var T=this.T;
var verts=[],idx=[],uvs=[];
    var tileW=4.0, tileH=3.2; // метр на квадрат текстуры
    var vMax=Math.max(1,height/tileH); // повтор текстуры по вертикали
    for(var i=0;i<ring.length;i++){
      var a=ring[i], b=ring[(i+1)%ring.length];
      var dx=b[0]-a[0], dz=b[1]-a[1];
      var len=Math.sqrt(dx*dx+dz*dz);
      if(len<0.01)continue;
      var u0=0,u1=len;
      // текстура тайлится и по U (ширина стены), и по V (высота),
      // поэтому окна сохраняют пропорции и стыки не видны.
      var base=verts.length/3;
      verts.push(a[0],0,a[1]);
      verts.push(b[0],0,b[1]);
      verts.push(a[0],height,a[1]);
      verts.push(b[0],height,b[1]);
      uvs.push(u0/tileW,vMax);
      uvs.push(u1/tileW,vMax);
      uvs.push(u0/tileW,0);
      uvs.push(u1/tileW,0);
idx.push(base,base+2,base+1, base+1,base+2,base+3);
    }
    var geo=new T.BufferGeometry();
    geo.setAttribute("position",new T.Float32BufferAttribute(verts,3));
    geo.setIndex(idx);
    geo.setAttribute("uv",new T.Float32BufferAttribute(uvs,2));
    geo.computeVertexNormals();
    return geo;
  }

  init(){
    var T=window.THREE; if(!T)return false; this.T=T;
    this._raycaster=new T.Raycaster();
    this.scene=new T.Scene();
    this.scene.background=new T.Color(this.o.bg);
    this.scene.fog=new T.FogExp2(0xc8dae8,0.001);
    var w=this.el.clientWidth,h=this.el.clientHeight;
    this.cam=new T.PerspectiveCamera(this.o.fov,w/Math.max(1,h),0.5,50000);
    this.ren=new T.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
    this.ren.setSize(w,h); this.ren.setPixelRatio(Math.min(devicePixelRatio,2));
    this.ren.shadowMap.enabled=true; this.ren.shadowMap.type=T.PCFSoftShadowMap;
    this.ren.toneMapping=T.ACESFilmicToneMapping; this.ren.toneMappingExposure=1.1;
    this.el.appendChild(this.ren.domElement);

    var self=this;
    this.el.style.cursor="grab";
    this.el.addEventListener("pointerdown",function(e){
      self._dragging=true; self._lastMX=e.clientX; self._lastMY=e.clientY;
      self._clickStartX=e.clientX; self._clickStartY=e.clientY;
      self.el.style.cursor="grabbing"; e.preventDefault();
    });
    window.addEventListener("pointermove",function(e){
      if(!self._dragging)return;
      var dx=e.clientX-self._lastMX, dy=e.clientY-self._lastMY;
      self._lastMX=e.clientX; self._lastMY=e.clientY;
      self.yaw-=dx*0.15;
      self.pitch+=dy*0.15;
      self.pitch=Math.max(-85,Math.min(10,self.pitch));
    });
    window.addEventListener("pointerup",function(e){
      if(!self._dragging)return;
      self._dragging=false; self.el.style.cursor="grab";
      // ★ Клик по зданию (если мышь не двигалась)
      var moved=Math.abs(e.clientX-self._clickStartX)+Math.abs(e.clientY-self._clickStartY);
      if(moved<5) self._handleClick(e);
    });

    this.scene.add(new T.AmbientLight(0xffffff,0.6));
    var h2=new T.HemisphereLight(0x87CEEB,0x5a7247,0.7); h2.position.set(0,500,0); this.scene.add(h2);
    var s=new T.DirectionalLight(0xfff8e8,1.0); s.position.set(200,500,150);
    s.castShadow=true; s.shadow.mapSize.set(2048,2048);
    var sc=s.shadow.camera; sc.near=1;sc.far=3000;sc.left=sc.bottom=-600;sc.right=sc.top=600;
    this.scene.add(s);
    var f=new T.DirectionalLight(0xFFF0E0,0.25); f.position.set(-200,400,-100); this.scene.add(f);

    window.addEventListener("resize",this._resize); return true;
  }

  _handleClick(e){
    if(!this._raycaster||!this.cam||!this.group)return;
    var rect=this.el.getBoundingClientRect();
    this._mouse.x=((e.clientX-rect.left)/rect.width)*2-1;
    this._mouse.y=-((e.clientY-rect.top)/rect.height)*2+1;
    this._raycaster.setFromCamera(this._mouse,this.cam);
    var hits=this._raycaster.intersectObjects(this.group.children,true);
    if(hits.length>0){
      // Ищем родительскую группу здания
      var obj=hits[0].object;
      while(obj.parent&&obj.parent!==this.group) obj=obj.parent;
      if(obj.userData&&obj.userData.buildingIndex!=null){
        var bData=this._buildings[obj.userData.buildingIndex];
        if(bData&&this.onBuildingClick) this.onBuildingClick(bData);
      }
    }
  }

  _estimateCameraHeight(camX, camZ){
    if(!this.cam||!this.group||!this._buildingMeshes.length)return 80;
    this.cam.position.set(camX, 80, camZ);
    var yawRad=this.yaw*Math.PI/180,pitchRad=this.pitch*Math.PI/180;
    var lookDir=new this.T.Vector3(Math.sin(yawRad)*Math.cos(pitchRad),Math.sin(pitchRad),-Math.cos(yawRad)*Math.cos(pitchRad));
    this.cam.lookAt(camX + lookDir.x * 1200, 20 + lookDir.y * 400, camZ + lookDir.z * 1200);
    this.cam.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    var frustum=new this.T.Frustum();
    var projScreenMatrix=new this.T.Matrix4();
    projScreenMatrix.multiplyMatrices(this.cam.projectionMatrix,this.cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);
    var highest=0;
    for(var i=0;i<this._buildingMeshes.length;i++){
      var mesh=this._buildingMeshes[i];
      if(!mesh)continue;
      var box=new this.T.Box3().setFromObject(mesh);
      if(frustum.intersectsBox(box)) highest=Math.max(highest, this._buildings[i]&&this._buildings[i].height?this._buildings[i].height:0);
    }
    if(highest<=0) return 80;
    return Math.max(40, highest + 25 + Math.max(10, highest * 0.2));
  }

  load(data, camX, camZ, camY){
    var T=this.T, blds=data.buildings||[], rds=data.roads||[], trs=data.trees||[], grns=data.greens||[], wtrs=data.waters||[], r=data.radius_m||500;
    camX=camX||0; camZ=camZ||0;
    this._buildings=blds;
    this._buildingMeshes=[];
    this._plans=data.plans||[];

    // Нейтральная городская подложка: бетон/асфальт вместо сплошной травы.
    if(this.ground){this.scene.remove(this.ground);this.ground.geometry.dispose();this.ground.material.dispose();}
var sz=Math.max(r*3,3000);
    this.ground=new T.Mesh(new T.PlaneGeometry(sz,sz),new T.MeshStandardMaterial({map:this._makeGroundTexture(),roughness:0.95,metalness:0.0}));
    this.ground.rotation.x=-Math.PI/2;this.ground.position.y=-0.05;this.ground.receiveShadow=true;this.scene.add(this.ground);

    // Зелёная поверхность рисуется только для forest / wood / park из OSM.
    if(this.greenGroup){this.scene.remove(this.greenGroup);this.greenGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});}
    this.greenGroup=new T.Group();
    var greenMat=new T.MeshStandardMaterial({color:0x55734c,roughness:1.0,side:T.DoubleSide});
    for(var gi=0;gi<grns.length&&gi<600;gi++){
      var greenRing=grns[gi];if(!greenRing||greenRing.length<3)continue;
      try{
        var greenShape=this._osmShape(greenRing);
        var greenGeo=new T.ShapeGeometry(greenShape);greenGeo.rotateX(-Math.PI/2);
        var greenMesh=new T.Mesh(greenGeo,greenMat);greenMesh.position.y=0;greenMesh.receiveShadow=true;
        this.greenGroup.add(greenMesh);
      }catch(e){}
    }
    this.scene.add(this.greenGroup);

    // Дороги: low-poly ленты с аккуратными стыками и одной общей геометрией разметки.
    if(this.roadGroup){this.scene.remove(this.roadGroup);this.roadGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});}
    if(this.roadMarkingGroup){this.scene.remove(this.roadMarkingGroup);this.roadMarkingGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});}
    this.roadGroup=new T.Group();
    this.roadMarkingGroup=new T.Group();
    var markingVerts=[],markingIdx=[],markingVertexLimit=120000;

    function appendMarkQuad(x1,z1,x2,z2,lineWidth){
      if(markingVerts.length/3+4>markingVertexLimit)return;
      var dx=x2-x1,dz=z2-z1,len=Math.sqrt(dx*dx+dz*dz);if(len<0.02)return;
      var nx=-dz/len*lineWidth*0.5,nz=dx/len*lineWidth*0.5,base=markingVerts.length/3;
      markingVerts.push(x1+nx,0.065,z1+nz,x1-nx,0.065,z1-nz,x2+nx,0.065,z2+nz,x2-nx,0.065,z2-nz);
      markingIdx.push(base,base+1,base+2,base+1,base+3,base+2);
    }
    function appendDashedLine(path,offset){
      var travelled=0,dash=5,gap=4,cycle=dash+gap;
      for(var si=0;si<path.length-1;si++){
        var a=path[si],b=path[si+1],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.sqrt(dx*dx+dz*dz);if(len<0.02)continue;
        var ux=dx/len,uz=dz/len,nx=-uz,nz=ux,local=0;
        while(local<len&&markingVerts.length/3<markingVertexLimit){
          var phase=(travelled+local)%cycle;
          var painted=phase<dash;
          var step=Math.min((painted?dash:cycle)-phase,len-local);
          if(step<0.001)step=Math.min(0.01,len-local);
          if(painted){
            appendMarkQuad(a[0]+ux*local+nx*offset,a[1]+uz*local+nz*offset,a[0]+ux*(local+step)+nx*offset,a[1]+uz*(local+step)+nz*offset,0.14);
          }
          local+=step;
        }
        travelled+=len;
      }
    }
    function appendSolidLine(path,offset){
      for(var si=0;si<path.length-1;si++){
        var a=path[si],b=path[si+1],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.sqrt(dx*dx+dz*dz);if(len<0.02)continue;
        var nx=-dz/len,nz=dx/len;
        appendMarkQuad(a[0]+nx*offset,a[1]+nz*offset,b[0]+nx*offset,b[1]+nz*offset,0.12);
      }
    }
    function stripOffset(path,index,halfWidth,side){
      var prev=index>0?path[index-1]:path[index],next=index<path.length-1?path[index+1]:path[index];
      var dx1=path[index][0]-prev[0],dz1=path[index][1]-prev[1],l1=Math.sqrt(dx1*dx1+dz1*dz1);
      var dx2=next[0]-path[index][0],dz2=next[1]-path[index][1],l2=Math.sqrt(dx2*dx2+dz2*dz2);
      if(l1<0.001){dx1=dx2;dz1=dz2;l1=l2||1;}if(l2<0.001){dx2=dx1;dz2=dz1;l2=l1||1;}
      var n1x=-dz1/l1,n1z=dx1/l1,n2x=-dz2/l2,n2z=dx2/l2;
      var mx=n1x+n2x,mz=n1z+n2z,ml=Math.sqrt(mx*mx+mz*mz);
      if(ml<0.001){mx=n2x;mz=n2z;ml=1;}
      mx/=ml;mz/=ml;
      var denom=Math.max(0.55,Math.abs(mx*n2x+mz*n2z));
      var scale=Math.min(halfWidth*1.8,halfWidth/denom)*side;
      return [path[index][0]+mx*scale,path[index][1]+mz*scale];
    }

    for(var ri=0;ri<rds.length;ri++){
      var rd=rds[ri];if(!rd.path||rd.path.length<2)continue;
      var halfW=Number(rd.width||4)*0.5,verts=[],idxs=[];
      for(var pi=0;pi<rd.path.length;pi++){
        var left=stripOffset(rd.path,pi,halfW,1),right=stripOffset(rd.path,pi,halfW,-1);
        verts.push(left[0],0.03,left[1],right[0],0.03,right[1]);
        if(pi>0){var bi=(pi-1)*2;idxs.push(bi,bi+1,bi+2,bi+1,bi+3,bi+2);}
      }
      var geo=new T.BufferGeometry();geo.setAttribute("position",new T.Float32BufferAttribute(verts,3));geo.setIndex(idxs);geo.computeVertexNormals();
      var mat=new T.MeshStandardMaterial({color:new T.Color(rd.color||"#4b5053"),roughness:0.96,metalness:0.0,side:T.DoubleSide});
      var mesh=new T.Mesh(geo,mat);mesh.receiveShadow=true;this.roadGroup.add(mesh);

      var lanes=Math.max(1,Math.min(8,Math.round(Number(rd.lanes)||1)));
      if(rd.markings&&lanes>=2){
        var laneWidth=Number(rd.width||4)/lanes;
        for(var li=1;li<lanes;li++)appendDashedLine(rd.path,-halfW+laneWidth*li);
      }
      if(rd.edge_lines){
        appendSolidLine(rd.path,Math.max(0,halfW-0.3));
        appendSolidLine(rd.path,-Math.max(0,halfW-0.3));
      }
    }
this.scene.add(this.roadGroup);
    if(markingVerts.length){
      var markingGeo=new T.BufferGeometry();markingGeo.setAttribute("position",new T.Float32BufferAttribute(markingVerts,3));markingGeo.setIndex(markingIdx);markingGeo.computeVertexNormals();
      var markingMat=new T.MeshStandardMaterial({color:0xf4f1df,roughness:0.8,metalness:0.0,side:T.DoubleSide});
      var markingMesh=new T.Mesh(markingGeo,markingMat);markingMesh.receiveShadow=true;markingMesh.renderOrder=3;
      this.roadMarkingGroup.add(markingMesh);
    }
    this.scene.add(this.roadMarkingGroup);

    // ★ Тротуары: светло-серые полосы чуть шире дороги, под асфальтом
    if(this._sidewalkGroup){this.scene.remove(this._sidewalkGroup);this._sidewalkGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}
    this._sidewalkGroup=new T.Group();
    var swMat=new T.MeshStandardMaterial({color:0x9a9a93,roughness:0.95,metalness:0.0,side:T.DoubleSide});
    for(var si_=0;si_<rds.length;si_++){
      var srd=rds[si_];if(!srd.path||srd.path.length<2)continue;
      var swHw=Number(srd.width||4)*0.5+1.6;
      var sverts=[],sidx=[];
      for(var spi=0;spi<srd.path.length;spi++){
        var sl=stripOffset(srd.path,spi,swHw,1),sr=stripOffset(srd.path,spi,swHw,-1);
        sverts.push(sl[0],-0.02,sl[1],sr[0],-0.02,sr[1]);
        if(spi>0){var sbi=(spi-1)*2;sidx.push(sbi,sbi+1,sbi+2,sbi+1,sbi+3,sbi+2);}
      }
var sgeo=new T.BufferGeometry();sgeo.setAttribute("position",new T.Float32BufferAttribute(sverts,3));sgeo.setIndex(sidx);sgeo.computeVertexNormals();
      var smesh=new T.Mesh(sgeo,swMat);smesh.receiveShadow=true;this._sidewalkGroup.add(smesh);
    }
    this.scene.add(this._sidewalkGroup);

    // ★ Фонари: столбы с эмиссивными головками вдоль дорог
    if(this._lampGroup){this.scene.remove(this._lampGroup);this._lampGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}
    this._lampGroup=new T.Group();
    var lampPoleMat=new T.MeshStandardMaterial({color:0x3a3d42,roughness:0.6,metalness:0.6});
    var lampHeadMat=new T.MeshStandardMaterial({color:0xfff2c0,emissive:0xffeeaa,emissiveIntensity:0.9,roughness:0.4,metalness:0.1});
    var lampHeadMatDim=new T.MeshStandardMaterial({color:0xcfc8ac,emissive:0x88774a,emissiveIntensity:0.25,roughness:0.5,metalness:0.1});
    var lampCount=0;
    for(var li_=0;li_<rds.length&&lampCount<260;li_++){
      var lrd=rds[li_];
      if(!lrd.path||lrd.path.length<2)continue;
      var lW=Number(lrd.width||4)*0.5+1.4;
      var lWd=Number(lrd.width||4);
      if(lWd<3)continue; // только дороги с тротуарами
      var travelled=0,spacing=26+Math.random()*14;
      for(var lsi=0;lsi<lrd.path.length-1&&lampCount<260;lsi++){
        var la=lrd.path[lsi],lb=lrd.path[lsi+1];
        var ldx=lb[0]-la[0],ldz=lb[1]-la[1];
        var llen=Math.sqrt(ldx*ldx+ldz*ldz);if(llen<0.02)continue;
        var lux=ldx/llen,luz=ldz/llen;
        var lnx=-luz,lnz=lux;
        var local=0;
        var sideDir=(lampCount%2===0?1:-1);
        while(local<llen&&lampCount<260){
          var placed=false;
          if(local>=travelled%spacing){
            var px=la[0]+lux*local+lnx*lW*sideDir;
            var pz=la[1]+luz*local+lnz*lW*sideDir;
            // столб
            var pole=new T.Mesh(new T.CylinderGeometry(0.14,0.2,6.5,6),lampPoleMat);
            pole.position.set(px,3.25,pz);pole.castShadow=true;this._lampGroup.add(pole);
            // голова
            var head=new T.Mesh(new T.BoxGeometry(0.9,0.25,0.5),lampHeadMat);
            head.position.set(px+lnx*0.5,lampCount%2===0?6.6:6.6,pz+lnz*0.5);this._lampGroup.add(head);
            // кронштейн
            var arm=new T.Mesh(new T.CylinderGeometry(0.05,0.05,0.6,4),lampPoleMat);
            arm.position.set(px+lnx*0.3,6.4,pz+lnz*0.3);
            arm.rotation.z=Math.PI/2;
            arm.rotation.y=Math.atan2(lnz,lnx);
this._lampGroup.add(arm);
            lampCount++;placed=true;
          }
          if(placed){travelled=0;local+=1.2;sideDir=-sideDir;}
          else local+=0.5;
        }
      }
    }
    this.scene.add(this._lampGroup);

    // ★ Пешеходные переходы (зебра) на пересечениях дорог
    if(this._crosswalkGroup){this.scene.remove(this._crosswalkGroup);this._crosswalkGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}
    this._crosswalkGroup=new T.Group();
    var zebraMat=new T.MeshStandardMaterial({color:0xf4f1df,roughness:0.8,metalness:0.0,side:T.DoubleSide});
    if(rds.length>1){
      // соберём все endpoints дорог и найдём пары близких endpoint'ов
      var endpoints=[];
      for(var ei=0;ei<rds.length;ei++){
        var erd=rds[ei];if(!erd.path||erd.path.length<2)continue;
        var first=erd.path[0],last=erd.path[erd.path.length-1];
        endpoints.push({x:first[0],z:first[1],rd:erd});endpoints.push({x:last[0],z:last[1],rd:erd});
      }
      var usedEps={};
      var cwDone=0;
      for(var a=0;a<endpoints.length&&cwDone<40;a++){
        for(var b=a+1;b<endpoints.length&&cwDone<40;b++){
          var pa=endpoints[a],pb=endpoints[b];
          if(pa.x===pb.x&&pa.z===pb.z)continue;
          var ddx=pb.x-pa.x,ddz=pb.z-pa.z;
          var dd=Math.sqrt(ddx*ddx+ddz*ddz);
          if(dd<1.5||dd>14)continue;
          if(usedEps[a]||usedEps[b])continue;
          // центр пересечения
          var mix=(pa.x+pb.x)/2,miz=(pa.z+pb.z)/2;
          // ширина проезжей части вокруг
          var roadW=Math.max(Number(pa.rd.width||4),Number(pb.rd.width||4));
          var cwLen=roadW+1.2;
          // направление зебры: перпендикулярно линии между endpoints
          var nx=-ddz/dd,nz=ddx/dd;
          var cx1=mix-nx*cwLen*0.5,cz1=miz-nz*cwLen*0.5;
          var cx2=mix+nx*cwLen*0.5,cz2=miz+nz*cwLen*0.5;
          // рисуем полосы поперёк
          var pdx=cx2-cx1,pdz=cz2-cz1,plen=Math.sqrt(pdx*pdx+pdz*pdz);if(plen<0.1)continue;
          var pux=pdx/plen,puz=pdz/plen;
          var pnx=-puz,pnz=pux;
          var stripeW=0.5,stripeGap=0.5,off=-(cwLen/2);
          for(var st=0;st<20;st++){
            var so=off+st*(stripeW+stripeGap);
            if(so>cwLen/2)break;
            var s1x=cx1+pux*so,s1z=cz1+puz*so;
            var s2x=s1x+pnx*stripeW,s2z=s1z+pnz*stripeW;
            var s3x=s1x+pux*(so+stripeW),s3z=s1z+puz*(so+stripeW);
            var s4x=s3x+pnx*stripeW,s4z=s3z+pnz*stripeW;
            var zebraGeo=new T.BufferGeometry();
            zebraGeo.setAttribute("position",new T.Float32BufferAttribute([s1x,0.07,s1z,s2x,0.07,s2z,s3x,0.07,s3z,s2x,0.07,s2z,s3x,0.07,s3z,s4x,0.07,s4z],3));
            zebraGeo.computeVertexNormals();
            var zm=new T.Mesh(zebraGeo,zebraMat);zm.renderOrder=4;this._crosswalkGroup.add(zm);
          }
          usedEps[a]=true;usedEps[b]=true;cwDone++;
        }
      }
    }
    this.scene.add(this._crosswalkGroup);

    // ★ Автомобили: low-poly вдоль широких дорог
    if(this._carGroup){this.scene.remove(this._carGroup);this._carGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}
    this._carGroup=new T.Group();
    var carPool=[0xcc3333,0x2f6fd0,0xd8d8d8,0x1f1f2a,0x5a8f3c,0xe0a030,0x8b5a83,0x444444];
var carCount=0;
    for(var ci=0;ci<rds.length&&carCount<70;ci++){
      var crd=rds[ci];if(!crd.path||crd.path.length<3)continue;
      var cW=Number(crd.width||4);
      if(cW<6.5)continue; // паркуемся только на широких улицах
      var cLen=crd.path.length;
      for(var ps=0;ps<cLen-1&&carCount<70;ps++){
        var cA=crd.path[ps],cB=crd.path[ps+1];
        var cdx=cB[0]-cA[0],cdz=cB[1]-cA[1];
        var clen=Math.sqrt(cdx*cdx+cdz*cdz);if(clen<4)continue;
        var cux=cdx/clen,cuz=cdz/clen;
        var cnx=-cuz,cnz=cux;
        var side=((ps+ci)%2===0?1:-1);
        var off=(cW/2)*0.55*side;
        var px=cA[0]+cux*(clen*0.5)+cnx*off;
        var pz=cA[1]+cuz*(clen*0.5)+cnz*off;
        var carCol=carPool[(ci+ps)%carPool.length];
        var body=new T.Mesh(new T.BoxGeometry(2.0,0.7,4.2),new T.MeshStandardMaterial({color:carCol,roughness:0.3,metalness:0.5}));
        body.position.set(px,0.35,pz);
        var cabin=new T.Mesh(new T.BoxGeometry(1.7,0.6,2.2),new T.MeshStandardMaterial({color:0x1a2a3a,roughness:0.2,metalness:0.6}));
        cabin.position.set(px,0.9,pz);
        var car=new T.Group();car.add(body);car.add(cabin);
        car.position.set(px,0,pz);car.rotation.y=Math.atan2(cux,cuz);
        body.position.set(0,0.35,0);cabin.position.set(0,0.9,0);
        car.castShadow=true;this._carGroup.add(car);carCount++;
      }
    }
    this.scene.add(this._carGroup);

    // Водоёмы
    if(this.waterGroup){this.scene.remove(this.waterGroup);this.waterGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});}
    this.waterGroup=new T.Group();
    var waterMat=new T.MeshStandardMaterial({color:0x4a90d9,roughness:0.3,metalness:0.1,transparent:true,opacity:0.85,side:T.DoubleSide});
    for(var wi=0;wi<wtrs.length;wi++){var wr=wtrs[wi];if(wr.length<3)continue;try{var wShape=this._osmShape(wr);var wGeo=new T.ShapeGeometry(wShape);wGeo.rotateX(-Math.PI/2);var wMesh=new T.Mesh(wGeo,waterMat);wMesh.position.y=0.01;this.waterGroup.add(wMesh);}catch(e){}}
    this.scene.add(this.waterGroup);

    // Здания + планы на крышах
    if(this.group){this.scene.remove(this.group);this.group.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}
    this.group=new T.Group();var cnt=0;
    for(var i=0;i<blds.length&&cnt<3000;i++){
      var b=blds[i],ring=b.ring,h=b.height; if(!ring||ring.length<3||!h)continue;
try{
        var sh=this._osmShape(ring);
        var col=new T.Color(b.color);

// ★ Стены с бесшовным фасадом (окна/панели вместо плоского цвета)
        var wallGeo=this._buildWallGeometry(ring,h);
        var facadeMat=new T.MeshStandardMaterial({
          map:this._getFacadeTexture(b.type||"residential",b.color),
          roughness:0.82,metalness:0.05,
          side:T.DoubleSide
        });
        // ★ Реальные материалы из OSM — подстраиваем металличность/шероховатость
        if(b.material){
          if(b.material==="glass"||b.material==="glazing"){facadeMat.metalness=0.6;facadeMat.roughness=0.2;}
          else if(b.material==="metal"){facadeMat.metalness=0.7;facadeMat.roughness=0.35;}
          else if(b.material==="concrete"){facadeMat.roughness=0.95;facadeMat.metalness=0.0;}
          else if(b.material==="brick"){facadeMat.roughness=0.9;facadeMat.metalness=0.0;}
          else if(b.material==="wood"){facadeMat.roughness=0.95;facadeMat.metalness=0.0;}
        }
        var w=new T.Mesh(wallGeo,facadeMat);
        w.castShadow=w.receiveShadow=true;

        // ★ Крыша по реальной форме из OSM (roof:shape)
        var roofShape=b.roof_shape||"flat";
        var roofH=b.roof_height;
        var rg=this._makeRoofGeometry(sh,roofShape,h,roofH);

        // Крыша: с планом или без
        var roofMat;
        if(b.plan){
          // ★ План на крыше — загружаем текстуру
          roofMat=new T.MeshStandardMaterial({color:0xffffff,roughness:0.5,metalness:0.0});
          var loader=new T.TextureLoader();
          loader.load("/plans/"+b.plan,function(m){return function(tex){
            tex.encoding=T.sRGBEncoding;
            m.map=tex; m.needsUpdate=true;
          };}(roofMat));
        }else{
          // текстура крыши рубероид/плитка, цвет — из OSM roof:colour если есть
          var roofColour=b.roof_colour||b.color;
          roofMat=new T.MeshStandardMaterial({
            map:this._getRoofTexture(roofColour),
            roughness:0.9,metalness:0.0
          });
        }
        var rf=new T.Mesh(rg,roofMat);
        rf.position.y=h+0.01;rf.castShadow=true;

        var g=new T.Group();g.add(w);g.add(rf);
        g.userData={buildingIndex:i}; // ★ для raycasting
        this.group.add(g);this._buildingMeshes.push(g);cnt++;
      }catch(e){}
    }
    this.scene.add(this.group);

    var autoCamY = (typeof camY === "number" && isFinite(camY)) ? camY : null;
    if(autoCamY == null){
      autoCamY=this._estimateCameraHeight(camX, camZ);
    }
    this._camPos={x:camX,y:autoCamY,z:camZ};
    this.cam.position.set(camX, autoCamY, camZ);

// Деревья: лиственные (шар) + хвойные (конус) для естественности
    if(this.treeGroup){this.scene.remove(this.treeGroup);this.treeGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});}
    this.treeGroup=new T.Group();
    var trunkMat=new T.MeshStandardMaterial({color:0x7a5a2a,roughness:0.9});
    var leafColors=[0x2d5a2d,0x3a7a3a,0x4a8a4a,0x2a6a2a,0x5a9a3a,0x3f7a3f];
    var conifColors=[0x1f4a2a,0x2a5a3a,0x1a3f2a];
    for(var ti=0;ti<trs.length&&ti<800;ti++){
      var t=trs[ti];
      var isConif=ti%3===0;
      var tree=new T.Group();
      if(isConif){
        var th=10+Math.random()*10;
        var trunk=new T.Mesh(new T.CylinderGeometry(0.25,0.4,th*0.25,5),trunkMat);
        trunk.position.set(0,th*0.12,0);trunk.castShadow=true;tree.add(trunk);
        var leafMat=new T.MeshStandardMaterial({color:conifColors[ti%conifColors.length],roughness:0.75});
        var c1=new T.Mesh(new T.ConeGeometry(2.2,th*0.4,7),leafMat);
        c1.position.set(0,th*0.35,0);c1.castShadow=true;tree.add(c1);
        var c2=new T.Mesh(new T.ConeGeometry(1.7,th*0.35,7),leafMat);
        c2.position.set(0,th*0.6,0);c2.castShadow=true;tree.add(c2);
        var c3=new T.Mesh(new T.ConeGeometry(1.1,th*0.3,7),leafMat);
        c3.position.set(0,th*0.82,0);c3.castShadow=true;tree.add(c3);
      }else{
        var th2=8+Math.random()*12,rw2=3+Math.random()*4;
        var trunk2=new T.Mesh(new T.CylinderGeometry(0.2,0.35,th2*0.4,5),trunkMat);
        trunk2.position.set(0,th2*0.2,0);trunk2.castShadow=true;tree.add(trunk2);
        var leafMat2=new T.MeshStandardMaterial({color:leafColors[ti%leafColors.length],roughness:0.8});
        var crown=new T.Mesh(new T.SphereGeometry(rw2,7,6),leafMat2);
        crown.position.set(0,th2*0.6,0);crown.castShadow=true;crown.scale.y=0.85;tree.add(crown);
      }
      tree.position.set(t.x,0,t.y);
      this.treeGroup.add(tree);
    }
    this.scene.add(this.treeGroup);

    // ★ Кустарники: по краям зелёных зон и около зданий
    if(this._bushGroup){this.scene.remove(this._bushGroup);this._bushGroup.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}
    this._bushGroup=new T.Group();
    var bushCols=[0x3a6a3a,0x4a7a4a,0x2f5a35,0x55804b];
    var bushMatCache=[];
    for(var bc=0;bc<bushCols.length;bc++)bushMatCache.push(new T.MeshStandardMaterial({color:bushCols[bc],roughness:0.85}));
    var bushCount=0;
    // около зданий
    for(var bi_=0;bi_<blds.length&&bushCount<400;bi_++){
      var bushB=blds[bi_],bushRing=bushB.ring;if(!bushRing||bushRing.length<3)continue;
      var bcx=0,bcy=0;for(var bri=0;bri<bushRing.length;bri++){bcx+=bushRing[bri][0];bcy+=bushRing[bri][1];}
      bcx/=bushRing.length;bcy/=bushRing.length;
      // средний размер здания
      var bminx=Infinity,bmaxx=-Infinity,bminy=Infinity,bmaxy=-Infinity;
      for(var ri2=0;ri2<bushRing.length;ri2++){bminx=Math.min(bminx,bushRing[ri2][0]);bmaxx=Math.max(bmaxx,bushRing[ri2][0]);bminy=Math.min(bminy,bushRing[ri2][1]);bmaxy=Math.max(bmaxy,bushRing[ri2][1]);}
      var bsize=Math.max(bmaxx-bminx,bmaxy-bminy);
      if(bsize<4||bsize>22)continue;
      var nbush=Math.min(3,1+Math.floor(bsize/8));
      for(var nbi=0;nbi<nbush&&bushCount<400;nbi++){
        var ang=Math.random()*Math.PI*2;
        var dist=bsize/2+1.2+Math.random()*1.5;
        var bx=bcx+Math.cos(ang)*dist;
        var bz=bcy+Math.sin(ang)*dist;
        var bush=new T.Mesh(new T.SphereGeometry(0.7+Math.random()*0.5,6,5),bushMatCache[bushCount%bushMatCache.length]);
        bush.position.set(bx,0.5,bz);bush.scale.y=0.8;bush.castShadow=true;
        this._bushGroup.add(bush);bushCount++;
      }
    }
    // в парках и зелёных зонах
    for(var pg=0;pg<grns.length&&bushCount<400;pg++){
      var gpoly=grns[pg];if(!gpoly||gpoly.length<3)continue;
      var gminx=Infinity,gmaxx=-Infinity,gminy=Infinity,gmaxy=-Infinity;
      for(var gvi=0;gvi<gpoly.length;gvi++){gminx=Math.min(gminx,gpoly[gvi][0]);gmaxx=Math.max(gmaxx,gpoly[gvi][0]);gminy=Math.min(gminy,gpoly[gvi][1]);gmaxy=Math.max(gmaxy,gpoly[gvi][1]);}
      var area=(gmaxx-gminx)*(gmaxy-gminy);
      var target=Math.min(30,Math.floor(area/400));
      for(var gb=0;gb<target&&bushCount<400;gb++){
        var gp=this._randomPointInPoly(gpoly);
        if(!gp)continue;
        var bush2=new T.Mesh(new T.SphereGeometry(0.6+Math.random()*0.6,6,5),bushMatCache[bushCount%bushMatCache.length]);
        bush2.position.set(gp[0],0.5,gp[1]);bush2.scale.y=0.8;bush2.castShadow=true;
        this._bushGroup.add(bush2);bushCount++;
      }
    }
    this.scene.add(this._bushGroup);
  }

  start(){this._frame();}
  _frame(){
    if(this.dead)return;this.raf=requestAnimationFrame(this._frame);
    var yawRad=this.yaw*Math.PI/180,pitchRad=this.pitch*Math.PI/180;
    var lookDir=new this.T.Vector3(Math.sin(yawRad)*Math.cos(pitchRad),Math.sin(pitchRad),-Math.cos(yawRad)*Math.cos(pitchRad));
    var p=this._camPos;
    this.cam.position.set(p.x,p.y,p.z);
    this.cam.lookAt(p.x+lookDir.x,p.y+lookDir.y,p.z+lookDir.z);
    this.ren.render(this.scene,this.cam);
  }
  getYaw(){return this.yaw;}getPitch(){return this.pitch;}getHfov(){if(!this.cam)return 75;var w=this.el.clientWidth,h=this.el.clientHeight,vfov=this.cam.fov*Math.PI/180;return 2*Math.atan(Math.tan(vfov/2)*(w/h))*180/Math.PI;}
  setYaw(deg,dur){var start=this.yaw,target=deg,t0=performance.now(),d=dur||700,self=this;(function a(){var t=Math.min(1,(performance.now()-t0)/d),e=t*(2-t);self.yaw=start+(target-start)*e;if(t<1)requestAnimationFrame(a);})();}
  _resize(){if(this.dead)return;var w=this.el.clientWidth,h=this.el.clientHeight;this.cam.aspect=w/Math.max(1,h);this.cam.updateProjectionMatrix();this.ren.setSize(w,h);}
  destroy(){
    this.dead=true;if(this.raf)cancelAnimationFrame(this.raf);window.removeEventListener("resize",this._resize);
[this.group,this.roadGroup,this.roadMarkingGroup,this.greenGroup,this.treeGroup,this.waterGroup,this._sidewalkGroup,this._lampGroup,this._crosswalkGroup,this._carGroup,this._bushGroup].forEach(function(g){if(g){this.scene.remove(g);g.traverse(function(c){if(c.geometry)c.geometry.dispose();if(c.material)(Array.isArray(c.material)?c.material:[c.material]).forEach(function(m){m.dispose();});});}}.bind(this));
    if(this.ground){this.scene.remove(this.ground);this.ground.geometry.dispose();this.ground.material.dispose();}
    if(this.ren){this.ren.dispose();if(this.ren.domElement.parentNode)this.ren.domElement.parentNode.removeChild(this.ren.domElement);}
    this.scene=this.cam=this.ren=null;
  }
}

window.AeroRenderer=AeroRenderer;
window.loadAero=async function(id,lat,lon,opts){
  var el=document.getElementById(id);if(!el)return null;
  el.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#ccc;gap:14px"><div style="width:36px;height:36px;border:3px solid rgba(255,255,255,.1);border-top-color:#4d8dff;border-radius:50%;animation:spin .8s linear infinite"></div><p>Загрузка зданий из OSM…</p></div>';
  var r=(opts&&opts.radius)||300,data;
  try{var res=await fetch("/api/osm-buildings?lat="+encodeURIComponent(lat)+"&lon="+encodeURIComponent(lon)+"&radius_m="+r);data=await res.json();if(data.status==="error")throw new Error(data.message);}
  catch(e){el.innerHTML='<p style="color:#f66;padding:20px">Ошибка: '+e.message+'</p>';return null;}
  el.innerHTML="";var ar=new AeroRenderer(el,opts);
  if(!ar.init()){el.innerHTML='<p style="color:#f66;padding:20px">WebGL не поддерживается</p>';return null;}
  ar.load(data,opts&&opts.camX,opts&&opts.camZ,opts&&opts.camY);ar.start();return ar;
};
})();
