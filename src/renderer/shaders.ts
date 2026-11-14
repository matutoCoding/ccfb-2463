// GLSL ES 3.00 着色器源码
// 点云节点数据布局：pos Float32*3 | nrm Int8*3（可选）| col Uint8*3（可选）

export const POINT_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;       // 相对藏品 origin
layout(location = 1) in vec3 aNormal;    // 量化后归一化的法线
layout(location = 2) in vec3 aColor;     // 0..1 真彩

uniform mat4 uViewProj;
uniform vec3 uOrigin;        // 藏品世界原点
uniform float uPointSize;
uniform float uMinElev;
uniform float uMaxElev;
uniform int uColorMode;      // 0 rgb / 1 elevation / 2 normal / 3 diff
uniform int uClipMode;       // 0 none / 1 plane / 2 box
uniform vec4 uClipPlane;     // xyz 法线, w 过点常数 d（normal·p + w > 0 保留）
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform sampler2D uDiffTex;  // 差异距离场（按点索引取色，比较模式）
uniform int uHasDiff;
uniform int uPickMode;       // 1 时输出点 ID 到拾取缓冲
uniform uint uPickBase;      // 本节点起始点编号
uniform float uPointScale;   // 高分截图时的尺寸补偿

out vec3 vColor;
out vec3 vNormal;
out float vElev;
out float vClip;
flat out float vPickId;

vec3 elevationRamp(float t) {
  // 蓝-青-绿-黄-红 高程色带
  vec3 c0 = vec3(0.10, 0.25, 0.75);
  vec3 c1 = vec3(0.15, 0.70, 0.85);
  vec3 c2 = vec3(0.25, 0.75, 0.35);
  vec3 c3 = vec3(0.95, 0.80, 0.25);
  vec3 c4 = vec3(0.85, 0.20, 0.15);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

vec3 diffRamp(float t) {
  // 差异：绿（近）-> 黄 -> 红（远）
  vec3 c0 = vec3(0.20, 0.75, 0.35);
  vec3 c1 = vec3(0.95, 0.85, 0.25);
  vec3 c2 = vec3(0.90, 0.20, 0.15);
  if (t < 0.5) return mix(c0, c1, t * 2.0);
  return mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
  vec3 world = aPos + uOrigin;

  // 裁剪（手动实现，兼容不支持 gl_ClipDistance 扩展的驱动）：
  // vClip < 0 的点在片元阶段 discard
  if (uClipMode == 1) {
    vClip = dot(uClipPlane.xyz, world) + uClipPlane.w;
  } else if (uClipMode == 2) {
    bool inside = all(greaterThanEqual(world, uClipMin)) && all(lessThanEqual(world, uClipMax));
    vClip = inside ? 1.0 : -1.0;
  } else {
    vClip = 1.0;
  }

  vec4 clip = uViewProj * vec4(world, 1.0);
  gl_Position = clip;
  gl_PointSize = uPointSize * uPointScale;

  vNormal = aNormal;
  vElev = clamp((world.y - uMinElev) / max(1e-6, uMaxElev - uMinElev), 0.0, 1.0);

  if (uColorMode == 0) {
    vColor = aColor;
  } else if (uColorMode == 1) {
    vColor = elevationRamp(vElev);
  } else if (uColorMode == 2) {
    vColor = normalize(aNormal) * 0.5 + 0.5;
  } else {
    vColor = aColor;
  }

  if (uHasDiff == 1) {
    // 差异纹理按线性点编号采样（r 存距离，g 存有效位）
    float u = (float(uPickBase) + float(gl_VertexID) + 0.5) / float(textureSize(uDiffTex, 0).x);
    vec2 d = texture(uDiffTex, vec2(u, 0.5)).rg;
    if (d.g > 0.5) {
      vColor = diffRamp(clamp(d.r, 0.0, 1.0));
    }
  }

  vPickId = float(uPickBase) + float(gl_VertexID) + 1.0; // 0 留给背景
}
`;

export const POINT_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec3 vColor;
in vec3 vNormal;
in float vElev;
in float vClip;
flat in float vPickId;

uniform int uPickMode;
uniform vec3 uLightDir;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outPick;

void main() {
  if (vClip < 0.0) discard;
  if (uPickMode == 1) {
    outColor = vec4(0.0);
    outPick = vPickId; // 0 留给背景
    return;
  }
  // 圆形点，去掉方形毛刺
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float shade = 0.75 + 0.25 * abs(dot(normalize(vNormal), normalize(uLightDir)));
  outColor = vec4(vColor * shade, 1.0);
  // 正常渲染也写拾取 ID，保证拾取附件与颜色附件逐像素对应
  outPick = vPickId;
}
`;

// ---------- EDL 后处理：深度邻域对比度（Eye-Dome Lighting）----------
export const ELD_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQuad;
out vec2 vUv;
void main() {
  vUv = aQuad * 0.5 + 0.5;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}
`;

export const EDL_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uRadius;
uniform vec3 uBackground;
uniform float uNear;
uniform float uFar;

out vec4 outColor;

float linearDepth(float d) {
  // 透视投影深度 -> 视空间距离
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  vec4 src = texture(uColorTex, vUv);
  float center = linearDepth(texture(uDepthTex, vUv).r);
  if (center >= uFar * 0.999) {
    outColor = vec4(uBackground, 1.0);
    return;
  }
  float occlusion = 0.0;
  float sumW = 0.0;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.785398163;
    vec2 off = vec2(cos(ang), sin(ang)) * uTexel * uRadius;
    float dn = linearDepth(texture(uDepthTex, vUv + off).r);
    float df = linearDepth(texture(uDepthTex, vUv - off).r);
    // 邻域更近 -> 阴影；更远或背景不产生阴影
    float fn = max(0.0, center - dn);
    float ff = max(0.0, center - df);
    float w = 1.0;
    occlusion += (fn + ff) * w;
    sumW += 2.0 * w;
  }
  occlusion /= max(1.0, sumW);
  float shade = exp(-occlusion * uStrength * 200.0 / max(1.0, center));
  vec3 rgb = src.rgb * shade;
  // 与背景轻微混合，抗锯齿
  outColor = vec4(rgb, 1.0);
}
`;

// ---------- 测量/剖面框线覆盖物 ----------
export const LINE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }
`;

export const LINE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }
`;
