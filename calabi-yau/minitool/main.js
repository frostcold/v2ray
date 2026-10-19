/* 卡拉比–丘投影模型 · 小工具版
 * 经典脚本，ES2017 以内；WebGL 1 渲染，带预算、降档、context 丢失处理与静态兜底。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("gl");

  // ---------- 性能分档（见 performance-budget §4） ----------
  var TIERS = [
    { name: "标准", dpr: 1.5, maxPixels: 2000000, maxTris: 100000 },
    { name: "省电", dpr: 1, maxPixels: 1000000, maxTris: 50000 }
  ];
  var tier = 0;

  // ---------- 着色器（GLSL ES 1.00） ----------
  var VS = [
    "attribute vec4 aP; attribute vec4 aTu; attribute vec4 aTv; attribute vec4 aC; attribute vec4 aInfo;",
    "uniform mat4 uProj; uniform mat4 uView;",
    "uniform vec4 uRot; uniform vec2 uAB; uniform float uExplode; uniform float uScale;",
    "varying vec3 vN; varying vec3 vPos; varying float vW; varying vec2 vZ1; varying vec2 vUV; varying float vPatch;",
    // 4D 旋转：z1、z2 各自相位旋转，再把 (Im z1, Im z2) 平面旋转 α，保留前三个分量
    "vec4 rot(vec4 p){",
    "  vec2 a = vec2(uRot.x*p.x - uRot.y*p.y, uRot.y*p.x + uRot.x*p.y);",
    "  vec2 b = vec2(uRot.z*p.z - uRot.w*p.w, uRot.w*p.z + uRot.z*p.w);",
    "  return vec4(a.x, b.x, uAB.x*a.y + uAB.y*b.y, -uAB.y*a.y + uAB.x*b.y);",
    "}",
    "void main(){",
    "  vec4 q = rot(aP);",
    "  vec3 pos = (q.xyz + uExplode*rot(aC).xyz) * uScale;",
    "  vec3 n = cross(rot(aTu).xyz, rot(aTv).xyz);",
    "  vec4 vp = uView * vec4(pos, 1.0);",
    "  vPos = vp.xyz; vN = (uView * vec4(n, 0.0)).xyz; vW = q.w * uScale;",
    "  vZ1 = aP.xy; vUV = aInfo.zw; vPatch = aInfo.x;",
    "  gl_Position = uProj * vp;",
    "}"
  ].join("\n");

  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "varying vec3 vN; varying vec3 vPos; varying float vW; varying vec2 vZ1; varying vec2 vUV; varying float vPatch;",
    "uniform int uMode; uniform int uLine; uniform float uVisible; uniform float uPatches; uniform vec4 uLineCol;",
    "vec3 hue(float h){ return clamp(abs(mod(h*6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }",
    "vec3 pal(float h){ return mix(vec3(0.55), hue(h), 0.62) * 0.95; }",
    "float tanh1(float x){ float e = exp(2.0*clamp(x, -8.0, 8.0)); return (e - 1.0)/(e + 1.0); }",
    "void main(){",
    "  if (vPatch > uVisible - 0.5) discard;",
    "  if (uLine == 1) { gl_FragColor = uLineCol; return; }",
    "  vec3 base;",
    "  if (uMode == 0) base = pal(vPatch/uPatches);",
    "  else if (uMode == 1) { float t = tanh1(vW*2.2);",
    "    base = t < 0.0 ? mix(vec3(0.82), vec3(0.20,0.42,0.90), -t) : mix(vec3(0.82), vec3(0.92,0.45,0.18), t); }",
    "  else if (uMode == 2) base = pal(atan(vZ1.y, vZ1.x)/6.2831853 + 0.5);",
    "  else { float c = mod(floor(vUV.x*10.0) + floor(vUV.y*10.0), 2.0); base = pal(vPatch/uPatches)*(0.62 + 0.38*c); }",
    "  vec3 n = vN; float ln = length(n); n = ln > 1e-12 ? n/ln : vec3(0.0,0.0,1.0);",
    "  vec3 v = normalize(-vPos);",
    "  if (dot(n, v) < 0.0) n = -n;",
    "  vec3 L1 = normalize(vec3(0.5,0.75,0.6)); vec3 L2 = normalize(vec3(-0.7,-0.2,0.4));",
    "  float d1 = max(dot(n,L1), 0.0); float d2 = max(dot(n,L2), 0.0);",
    "  float sp = pow(max(dot(n, normalize(L1+v)), 0.0), 48.0);",
    "  float rim = pow(1.0 - max(dot(n,v), 0.0), 3.0);",
    "  vec3 c = base*(0.20 + 0.78*d1 + 0.28*d2) + 0.32*sp + 0.22*rim*vec3(0.6,0.72,1.0);",
    "  gl_FragColor = vec4(pow(c, vec3(0.92)), 1.0);",
    "}"
  ].join("\n");

  // ---------- 状态 ----------
  var gl = null, prog = null, U = {}, A = {}, bufs = {}, triBuf = null, lineBuf = null;
  var triCount = 0, lineCount = 0, fitScale = 1, patches = 25, effRes = 28;
  var dirty = true, needsRender = true, running = false, lost = false, lostCount = 0, failed = false;
  var S = {};

  // ---------- 降级兜底 ----------
  function showFallback(msg) {
    failed = true;
    running = false;
    canvas.style.display = "none";
    $("panel").classList.add("hidden");
    $("toggle").classList.add("hidden");
    $("legend").classList.add("hidden");
    $("fallbackMsg").textContent = msg;
    $("fallback").classList.remove("hidden");
  }

  // ---------- WebGL 初始化 ----------
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
    return s;
  }

  function initGL() {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
    gl.useProgram(prog);
    ["uProj", "uView", "uRot", "uAB", "uExplode", "uScale", "uMode", "uLine", "uVisible", "uPatches", "uLineCol"]
      .forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    ["aP", "aTu", "aTv", "aC", "aInfo"].forEach(function (n) {
      A[n] = gl.getAttribLocation(prog, n);
      bufs[n] = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[n]);
      gl.enableVertexAttribArray(A[n]);
      gl.vertexAttribPointer(A[n], 4, gl.FLOAT, false, 0, 0);
    });
    triBuf = gl.createBuffer();
    lineBuf = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    dirty = true;
    needsRender = true;
  }

  // ---------- 几何：z1^n1 + z2^n2 = 1 ----------
  // z1 = e^{2πi k1/n1} cos(ξ)^{2/n1}, z2 = e^{2πi k2/n2} sin(ξ)^{2/n2}, ξ = x + iy, x∈[0,π/2], y∈[-a,a]
  function cpow(re, im, p) {
    var r = Math.sqrt(re * re + im * im);
    if (r < 1e-14) return [0, 0];
    var t = Math.atan2(im, re) * p, R = Math.pow(r, p);
    return [R * Math.cos(t), R * Math.sin(t)];
  }

  // 按三角形预算和 16 位索引上限确定实际分辨率
  function budgetRes(P, want) {
    var N = Math.min(want, Math.floor(Math.sqrt(TIERS[tier].maxTris / (2 * P))));
    N = Math.max(4, N);
    while (N > 4 && P * (N + 1) * (N + 1) > 65535) N--;
    return N;
  }

  function build(n1, n2, a, want) {
    patches = n1 * n2;
    var N = effRes = budgetRes(patches, want);
    var W = N + 1, V = W * W, i, j, k, c;
    var B = new Float64Array(V * 4);
    for (j = 0; j < W; j++) for (i = 0; i < W; i++) {
      var x = Math.PI / 2 * i / N, y = -a + 2 * a * j / N;
      var ch = Math.cosh(y), sh = Math.sinh(y), cx = Math.cos(x), sx = Math.sin(x);
      var z1 = cpow(cx * ch, -sx * sh, 2 / n1), z2 = cpow(sx * ch, cx * sh, 2 / n2);
      k = (j * W + i) * 4;
      B[k] = z1[0]; B[k + 1] = z1[1]; B[k + 2] = z2[0]; B[k + 3] = z2[1];
    }
    var Tu = new Float64Array(V * 4), Tv = new Float64Array(V * 4), cen = [0, 0, 0, 0], maxR = 1e-9;
    for (j = 0; j < W; j++) for (i = 0; i < W; i++) {
      k = (j * W + i) * 4;
      var i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, N), j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, N);
      for (c = 0; c < 4; c++) {
        Tu[k + c] = B[(j * W + i1) * 4 + c] - B[(j * W + i0) * 4 + c];
        Tv[k + c] = B[(j1 * W + i) * 4 + c] - B[(j0 * W + i) * 4 + c];
        cen[c] += B[k + c] / V;
      }
      maxR = Math.max(maxR, Math.sqrt(B[k] * B[k] + B[k + 1] * B[k + 1] + B[k + 2] * B[k + 2] + B[k + 3] * B[k + 3]));
    }
    fitScale = 1 / maxR;

    var total = patches * V * 4;
    var P = new Float32Array(total), TU = new Float32Array(total), TV = new Float32Array(total),
        C = new Float32Array(total), I = new Float32Array(total);
    // 乘以单位根是线性变换，切向量同样旋转
    function mul(src, o, r1, r2, dst, d) {
      dst[d] = src[o] * r1[0] - src[o + 1] * r1[1];
      dst[d + 1] = src[o] * r1[1] + src[o + 1] * r1[0];
      dst[d + 2] = src[o + 2] * r2[0] - src[o + 3] * r2[1];
      dst[d + 3] = src[o + 2] * r2[1] + src[o + 3] * r2[0];
    }
    var cc = new Float32Array(4);
    for (var k1 = 0; k1 < n1; k1++) for (var k2 = 0; k2 < n2; k2++) {
      var p = k1 * n2 + k2;
      var r1 = [Math.cos(2 * Math.PI * k1 / n1), Math.sin(2 * Math.PI * k1 / n1)];
      var r2 = [Math.cos(2 * Math.PI * k2 / n2), Math.sin(2 * Math.PI * k2 / n2)];
      mul(cen, 0, r1, r2, cc, 0);
      for (var v = 0; v < V; v++) {
        var d = (p * V + v) * 4, s = v * 4;
        mul(B, s, r1, r2, P, d); mul(Tu, s, r1, r2, TU, d); mul(Tv, s, r1, r2, TV, d);
        C.set(cc, d);
        I[d] = p; I[d + 1] = 0; I[d + 2] = (v % W) / N; I[d + 3] = Math.floor(v / W) / N;
      }
    }
    var up = function (name, data) { gl.bindBuffer(gl.ARRAY_BUFFER, bufs[name]); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
    up("aP", P); up("aTu", TU); up("aTv", TV); up("aC", C); up("aInfo", I);

    var tri = new Uint16Array(patches * N * N * 6), t = 0;
    var stride = Math.max(1, Math.round(N / 14)), lines = [];
    for (p = 0; p < patches; p++) {
      var o = p * V;
      for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
        var a0 = o + j * W + i, b0 = a0 + 1, c0 = a0 + W, d0 = c0 + 1;
        tri[t++] = a0; tri[t++] = b0; tri[t++] = c0; tri[t++] = b0; tri[t++] = d0; tri[t++] = c0;
      }
      for (j = 0; j <= N; j++) if (j % stride === 0 || j === N) for (i = 0; i < N; i++) lines.push(o + j * W + i, o + j * W + i + 1);
      for (i = 0; i <= N; i++) if (i % stride === 0 || i === N) for (j = 0; j < N; j++) lines.push(o + j * W + i, o + (j + 1) * W + i);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tri, gl.STATIC_DRAW); triCount = t;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(lines), gl.STATIC_DRAW); lineCount = lines.length;
  }

  // ---------- 矩阵（列主序） ----------
  function persp(fov, asp, n, f) { var t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
  function mul4(a, b) {
    var r = new Array(16);
    for (var c = 0; c < 4; c++) for (var ri = 0; ri < 4; ri++) {
      var s = 0;
      for (var k = 0; k < 4; k++) s += a[k * 4 + ri] * b[c * 4 + k];
      r[c * 4 + ri] = s;
    }
    return r;
  }
  function rx(t) { var c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; }
  function ry(t) { var c = Math.cos(t), s = Math.sin(t); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; }
  function tr(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }

  // ---------- 绘制 ----------
  var yaw = 0.6, pitch = 0.35, dist = 3.2;
  var D = Math.PI / 180;

  function draw(w, h) {
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.043, 0.051, 0.071, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var asp = w / h, fovY = 2 * Math.atan(Math.tan(0.375) / Math.min(asp, 1)); // 竖屏时保证横向完整
    gl.uniformMatrix4fv(U.uProj, false, persp(fovY, asp, 0.05, 100));
    gl.uniformMatrix4fv(U.uView, false, mul4(tr(0, 0, -dist), mul4(rx(pitch), mul4(ry(yaw), rx(-Math.PI / 2)))));
    gl.uniform4f(U.uRot, Math.cos(S.phi1 * D), Math.sin(S.phi1 * D), Math.cos(S.phi2 * D), Math.sin(S.phi2 * D));
    gl.uniform2f(U.uAB, Math.cos(S.alpha * D), Math.sin(S.alpha * D));
    gl.uniform1f(U.uExplode, S.explode);
    gl.uniform1f(U.uScale, fitScale / (1 + 0.6 * S.explode));
    gl.uniform1i(U.uMode, +$("mode").value);
    gl.uniform1f(U.uVisible, S.vis);
    gl.uniform1f(U.uPatches, patches);
    var surf = $("surf").checked;
    if (surf) {
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
      gl.uniform1i(U.uLine, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf);
      gl.drawElements(gl.TRIANGLES, triCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if ($("wire").checked) {
      gl.enable(gl.BLEND);
      gl.uniform4fv(U.uLineCol, surf ? [0.04, 0.05, 0.08, 0.55] : [0.55, 0.68, 1.0, 0.7]);
      gl.uniform1i(U.uLine, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineBuf);
      gl.drawElements(gl.LINES, lineCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    }
  }

  // 按分档的 DPR 与像素上限计算 drawing buffer 尺寸
  function bufferSize() {
    var T = TIERS[tier];
    var cw = canvas.clientWidth || 1, ch = canvas.clientHeight || 1;
    var dpr = Math.min(window.devicePixelRatio || 1, T.dpr);
    var px = cw * dpr * ch * dpr;
    if (px > T.maxPixels) dpr *= Math.sqrt(T.maxPixels / px);
    return [Math.max(1, Math.round(cw * dpr)), Math.max(1, Math.round(ch * dpr))];
  }

  // ---------- UI ----------
  var ctrls = ["n1", "n2", "a", "res", "vis", "alpha", "phi1", "phi2", "explode", "speed"];
  var fmt = {
    alpha: function (v) { return v.toFixed(0) + "°"; },
    phi1: function (v) { return v.toFixed(0) + "°"; },
    phi2: function (v) { return v.toFixed(0) + "°"; },
    a: function (v) { return v.toFixed(2); },
    explode: function (v) { return v.toFixed(2); },
    speed: function (v) { return v.toFixed(2) + "×"; }
  };
  var SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  function sup(n) { return String(n).split("").map(function (d) { return SUP[+d]; }).join(""); }

  function read(id) {
    var el = $(id);
    S[id] = parseFloat(el.value);
    el.nextElementSibling.value = fmt[id] ? fmt[id](S[id]) : String(S[id]);
  }
  function updateStats() {
    $("eq").textContent = "z₁" + sup(S.n1) + " + z₂" + sup(S.n2) + " = 1";
    if (effRes !== S.res) $("res").nextElementSibling.value = S.res + "→" + effRes;
    $("stats").textContent = "补丁 " + Math.min(S.vis, patches) + "/" + patches +
      " · 三角形 " + (triCount / 3).toLocaleString() + " · 画质 " + TIERS[tier].name +
      (effRes !== S.res ? " · 分辨率已按性能预算限制" : "");
  }
  function syncVisMax() {
    var v = $("vis"), max = S.n1 * S.n2, full = +v.value >= +v.max;
    v.max = max;
    if (full || +v.value > max) v.value = max;
    read("vis");
  }
  ctrls.forEach(function (id) {
    read(id);
    $(id).addEventListener("input", function () {
      read(id);
      if (id === "n1" || id === "n2") { $("preset").value = ""; syncVisMax(); }
      if (id === "n1" || id === "n2" || id === "a" || id === "res") dirty = true;
      needsRender = true;
      updateStats();
    });
  });
  ["mode", "surf", "wire"].forEach(function (id) {
    $(id).addEventListener("change", function () { needsRender = true; });
  });
  $("preset").addEventListener("change", function (e) {
    if (!e.target.value) return;
    var ab = e.target.value.split(",");
    $("n1").value = ab[0]; $("n2").value = ab[1];
    read("n1"); read("n2");
    $("vis").value = 99; syncVisMax();
    dirty = true; needsRender = true; updateStats();
  });
  $("toggle").addEventListener("click", function () { $("panel").classList.toggle("hidden"); });
  if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) $("panel").classList.add("hidden");

  function resetView() { yaw = 0.6; pitch = 0.35; dist = 3.2; needsRender = true; }
  $("reset").addEventListener("click", resetView);
  canvas.addEventListener("dblclick", resetView);

  // ---------- 手势：Pointer Events ----------
  var ptrs = {}, pinch0 = 0;
  function ptrList() { return Object.keys(ptrs).map(function (k) { return ptrs[k]; }); }
  canvas.addEventListener("pointerdown", function (e) {
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointermove", function (e) {
    var p = ptrs[e.pointerId];
    if (!p) return;
    var list = ptrList();
    if (list.length === 1) {
      yaw += (e.clientX - p.x) * 0.008;
      pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - p.y) * 0.008));
    }
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    list = ptrList();
    if (list.length === 2) {
      var dd = Math.sqrt(Math.pow(list[0].x - list[1].x, 2) + Math.pow(list[0].y - list[1].y, 2));
      if (pinch0) dist = Math.max(1.2, Math.min(12, dist * pinch0 / dd));
      pinch0 = dd;
    }
    needsRender = true;
  });
  function ptrUp(e) { delete ptrs[e.pointerId]; pinch0 = 0; }
  canvas.addEventListener("pointerup", ptrUp);
  canvas.addEventListener("pointercancel", ptrUp);
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    dist = Math.max(1.2, Math.min(12, dist * Math.exp(e.deltaY * 0.001)));
    needsRender = true;
  }, { passive: false });

  // ---------- 提示与预览 ----------
  var toastTimer = 0;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 2200);
  }
  function showPreview(url, msg) {
    $("previewImg").src = url;
    $("previewMsg").textContent = msg;
    $("preview").classList.remove("hidden");
  }
  $("previewClose").addEventListener("click", function () {
    $("preview").classList.add("hidden");
    $("previewImg").removeAttribute("src");
  });

  // ---------- 导出 3:4 图（仅在用户点击时读取一次画布） ----------
  function capture34() {
    var ow = canvas.width, oh = canvas.height;
    canvas.width = 1080; canvas.height = 1440; // 155 万像素，在标准档预算内
    draw(1080, 1440);
    var url = canvas.toDataURL("image/jpeg", 0.92);
    canvas.width = ow; canvas.height = oh;
    draw(ow, oh);
    return url;
  }

  // ---------- 小红书容器能力（window.xhs.miniTool） ----------
  function miniTool() { return window.xhs && window.xhs.miniTool; }
  function hasApi(name) { var mt = miniTool(); return !!(mt && typeof mt[name] === "function"); }
  async function toFilePath(dataUrl) {
    if (hasApi("writeTempFile")) {
      try {
        var r = await miniTool().writeTempFile({ data: dataUrl });
        if (r && r.filePath) return r.filePath;
      } catch (e) { /* 回退为 data URI */ }
    }
    return dataUrl;
  }
  function errText(e) { return (e && (e.errMsg || e.message)) || "未知错误"; }

  var busy = false;
  async function withBusy(fn) {
    if (busy || failed || lost || !gl) return;
    busy = true;
    $("save").disabled = true; $("post").disabled = true;
    try { await fn(); } finally {
      busy = false;
      $("save").disabled = false; $("post").disabled = false;
    }
  }

  $("save").addEventListener("click", function () {
    withBusy(async function () {
      var url = capture34();
      if (!hasApi("saveImageToPhotosAlbum")) {
        showPreview(url, "当前环境不支持保存到相册，请在小红书 App 内打开小工具使用。");
        return;
      }
      try {
        await miniTool().saveImageToPhotosAlbum({ filePath: await toFilePath(url) });
        toast("已保存到相册");
      } catch (e) { toast("保存失败：" + errText(e)); }
    });
  });

  $("post").addEventListener("click", function () {
    withBusy(async function () {
      var url = capture34();
      if (!hasApi("postNote")) {
        showPreview(url, "当前环境不支持发布笔记，请在小红书 App 内打开小工具使用。");
        return;
      }
      try {
        await miniTool().postNote({
          title: "卡拉比–丘流形 3D 投影",
          content: "用小工具生成的卡拉比–丘流形投影：z₁" + sup(S.n1) + " + z₂" + sup(S.n2) +
            " = 1，投影角 α=" + S.alpha.toFixed(0) + "°。弦论里蜷缩的额外维度，拖一拖就能转起来。#卡拉比丘 #弦论 #数学之美",
          pageType: "photo_publish",
          mediaInfo: { image_resources: [{ url: await toFilePath(url) }] }
        });
      } catch (e) { toast("发布未完成：" + errText(e)); }
    });
  });

  // ---------- 渲染循环、动态降档 ----------
  var last = 0, slowAcc = 0, slowN = 0;
  function animating() { return $("spin").checked || $("animA").checked || $("animP").checked; }

  function degrade(avgMs) {
    if (tier < TIERS.length - 1) {
      tier++;
      dirty = true;
      toast("检测到卡顿，已切换为省电画质");
    } else {
      $("spin").checked = false; $("animA").checked = false; $("animP").checked = false;
      toast("设备性能有限，已暂停动画（拖动仍可旋转）");
    }
    slowAcc = 0; slowN = 0;
    needsRender = true;
  }

  function frame(now) {
    if (!running) return;
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    var rawMs = last ? now - last : 0;
    last = now;

    var anim = animating();
    if (anim) {
      var sp = S.speed;
      if ($("spin").checked) yaw += dt * 0.25 * sp;
      if ($("animA").checked) { var ea = $("alpha"); ea.value = ((+ea.value + dt * 20 * sp) % 180).toFixed(1); read("alpha"); }
      if ($("animP").checked) {
        var e1 = $("phi1"), e2 = $("phi2");
        e1.value = ((+e1.value + dt * 24 * sp) % 360).toFixed(0);
        e2.value = ((+e2.value - dt * 24 * sp + 360) % 360).toFixed(0);
        read("phi1"); read("phi2");
      }
      needsRender = true;
      // 持续掉帧（< 约 22 FPS）则降档
      if (rawMs > 0) {
        slowAcc += rawMs; slowN++;
        if (slowN >= 90) {
          var avg = slowAcc / slowN;
          slowAcc = 0; slowN = 0;
          if (avg > 45) degrade(avg);
        }
      }
    } else {
      slowAcc = 0; slowN = 0;
    }

    if (dirty) { build(S.n1, S.n2, S.a, S.res); dirty = false; syncVisMax(); updateStats(); needsRender = true; }

    var size = bufferSize();
    if (canvas.width !== size[0] || canvas.height !== size[1]) { canvas.width = size[0]; canvas.height = size[1]; needsRender = true; }
    if (needsRender) { draw(canvas.width, canvas.height); needsRender = false; }
    requestAnimationFrame(frame);
  }

  function start() {
    if (running || failed || lost || !gl) return;
    running = true;
    last = 0; // 恢复后重置时间差，避免补算
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else { needsRender = true; start(); }
  });
  window.addEventListener("resize", function () { needsRender = true; });

  // ---------- context 丢失 / 恢复 ----------
  canvas.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    lost = true;
    stop();
    toast("渲染暂时中断，正在等待恢复…");
  });
  canvas.addEventListener("webglcontextrestored", function () {
    lostCount++;
    lost = false;
    if (lostCount > 3) { showFallback("3D 渲染多次中断，已切换为静态预览。"); return; }
    try {
      tier = TIERS.length - 1; // 恢复后使用省电档
      initGL();
      start();
    } catch (err) { showFallback("3D 渲染恢复失败，已切换为静态预览。"); }
  });

  // ---------- 启动 ----------
  var ctxOpts = { antialias: true, alpha: false, preserveDrawingBuffer: false };
  try {
    gl = canvas.getContext("webgl", ctxOpts) || canvas.getContext("experimental-webgl", ctxOpts);
  } catch (e) { gl = null; }
  if (!gl) {
    showFallback("当前设备不支持 WebGL，已显示静态预览。");
    return;
  }
  try {
    initGL();
  } catch (e) {
    showFallback("3D 渲染初始化失败，已显示静态预览。");
    return;
  }
  $("preset").value = "5,5";
  updateStats();
  start();
})();
