// WebGL2 渲染器：点云 FBO 离屏渲染 + EDL 后处理 + R32UI 拾取 + 覆盖物
import { OrbitCamera } from './camera';
import { v3, type Vec3 } from './math';
import type {
  ClipMode,
  ColorMode,
  Plane,
  ViewerSettings,
} from './types';
import type { GpuNode, OctreeLoader } from './octreeLoader';
import { EDL_FRAG, ELD_VERT, LINE_FRAG, LINE_VERT, POINT_FRAG, POINT_VERT } from '../renderer/shaders';

interface RenderTargets {
  width: number;
  height: number;
  fbo: WebGLFramebuffer;
  colorTex: WebGLTexture;
  depthTex: WebGLTexture;
  pickTex: WebGLTexture;
}

interface OverlayLine {
  points: Vec3[];
  color: [number, number, number, number];
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawnPoints: number;
  drawnNodes: number;
  gpuMB: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('着色器编译失败: ' + log);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('程序链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class PointCloudRenderer {
  readonly camera = new OrbitCamera();
  private gl: WebGL2RenderingContext;
  private pointProgram: WebGLProgram;
  private edlProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private quadVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private dummyDiffTex: WebGLTexture;
  private targets: RenderTargets | null = null;
  private canvas: HTMLCanvasElement;
  private clipMode: ClipMode = 'none';
  private clipPlane: Plane = { normal: [0, 0, 1], point: [0, 0, 0] };
  private clipBox: { min: Vec3; max: Vec3 } | null = null;
  private colorMode: ColorMode = 'rgb';
  private overlays: OverlayLine[] = [];
  private diffTexture: WebGLTexture | null = null;
  private diffMaxDistance = 1;
  private stats: RenderStats = { fps: 0, frameMs: 0, drawnPoints: 0, drawnNodes: 0, gpuMB: 0 };
  private frameTimes: number[] = [];
  private lastFrameTime = performance.now();
  private pointScale = 1;
  private rafHandle = 0;
  private renderCallback: (() => void) | null = null;
  private loader: OctreeLoader | null = null;
  private settings: ViewerSettings;
  private running = false;

  constructor(canvas: HTMLCanvasElement, settings: ViewerSettings) {
    this.canvas = canvas;
    this.settings = settings;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      console.warn('缺少 EXT_color_buffer_float，拾取/浮点缓冲可能受限');
    }
    this.pointProgram = program(gl, POINT_VERT, POINT_FRAG);
    this.edlProgram = program(gl, ELD_VERT, EDL_FRAG);
    this.lineProgram = program(gl, LINE_VERT, LINE_FRAG);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.lineVao = gl.createVertexArray()!;
    this.lineBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);

    // 常驻保底差异纹理：保证 uDiffTex 采样器始终绑定到合法纹理，
    // 避免 ANGLE/D3D 驱动下未绑定采样器引发的未定义行为
    this.dummyDiffTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummyDiffTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG32F, 1, 1, 0, gl.RG, gl.FLOAT,
      new Float32Array([0, 0]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setLoader(loader: OctreeLoader | null): void {
    this.loader = loader;
  }

  get glContext(): WebGL2RenderingContext {
    return this.gl;
  }

  setSettings(s: ViewerSettings): void {
    this.settings = s;
  }

  setColorMode(m: ColorMode): void {
    this.colorMode = m;
  }

  setClip(mode: ClipMode, plane?: Plane, box?: { min: Vec3; max: Vec3 }): void {
    this.clipMode = mode;
    if (plane) this.clipPlane = plane;
    if (box) this.clipBox = box;
  }

  setOverlays(lines: OverlayLine[]): void {
    this.overlays = lines;
  }

  setDiffData(distances: Float32Array | null, maxDistance: number): void {
    const gl = this.gl;
    if (this.diffTexture) {
      gl.deleteTexture(this.diffTexture);
      this.diffTexture = null;
    }
    if (!distances) return;
    // 打包成 R32F 纹理：r=归一化距离，用单独 alpha 通道存有效性
    const n = distances.length;
    const width = Math.min(4096, Math.max(1, Math.ceil(Math.sqrt(n * 4))));
    const height = Math.ceil(n / width);
    const data = new Float32Array(width * height * 2);
    for (let i = 0; i < n; i++) {
      const d = distances[i];
      if (Number.isFinite(d)) {
        data[i * 2] = Math.min(1, d / maxDistance);
        data[i * 2 + 1] = 1;
      }
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.diffTexture = tex;
    this.diffMaxDistance = maxDistance;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.camera.setAspect(w / h);
    this.createTargets(w, h);
  }

  private createTargets(w: number, h: number): void {
    const gl = this.gl;
    if (this.targets) {
      gl.deleteFramebuffer(this.targets.fbo);
      gl.deleteTexture(this.targets.colorTex);
      gl.deleteTexture(this.targets.depthTex);
      gl.deleteTexture(this.targets.pickTex);
    }
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const colorTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const depthTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, w, h, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // 拾取附件用 R32F 而非 R32UI：整数纹理在 ANGLE/D3D 上 readPixels 兼容性差，
    // 浮点纹理可稳定读回；点 ID（<2^24）按 float 编码无精度损失
    const pickTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, pickTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('帧缓冲不完整: 0x' + status.toString(16));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = { width: w, height: h, fbo, colorTex, depthTex, pickTex };
  }

  start(onFrame?: () => void): void {
    if (this.running) return;
    this.running = true;
    this.renderCallback = onFrame ?? null;
    const loop = () => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(loop);
      this.renderFrame();
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }

  private renderFrame(): void {
    const t0 = performance.now();
    this.resize();
    const gl = this.gl;
    const loader = this.loader;
    if (!this.targets) return;
    loader?.pump();

    const vp = this.camera.getViewProj();
    const eye = this.camera.getEye();
    let drawnPoints = 0;
    let drawnNodes = 0;
    let nodes: GpuNode[] = [];
    if (loader) {
      const sel = loader.selectLod(
        vp,
        eye,
        this.targets.height,
        this.camera.fovy,
        this.settings.lodPixelError,
      );
      nodes = sel.nodes;
    }

    // 1) 离屏点云 pass（颜色 + 拾取 + 深度）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.fbo);
    gl.viewport(0, 0, this.targets.width, this.targets.height);
    gl.clearBufferfv(gl.COLOR, 0, [...this.settings.background, 1]);
    gl.clearBufferfv(gl.COLOR, 1, [0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);

    if (nodes.length) {
      gl.useProgram(this.pointProgram);
      const u = (name: string) => gl.getUniformLocation(this.pointProgram, name);
      gl.uniformMatrix4fv(u('uViewProj'), false, vp);
      gl.uniform1f(u('uPointSize'), this.settings.pointSize);
      gl.uniform1f(u('uPointScale'), this.pointScale);
      gl.uniform1i(u('uColorMode'),
        this.colorMode === 'rgb' ? 0 : this.colorMode === 'elevation' ? 1 :
        this.colorMode === 'normal' ? 2 : 3);
      gl.uniform1i(u('uClipMode'),
        this.clipMode === 'none' ? 0 : this.clipMode === 'plane' ? 1 : 2);
      const n = this.clipPlane.normal;
      gl.uniform4f(u('uClipPlane'), n[0], n[1], n[2], -v3.dot(n, this.clipPlane.point));
      // 无条件初始化裁剪盒 uniform（无剖切时给安全默认值，避免未初始化垃圾值）
      if (this.clipBox) {
        gl.uniform3fv(u('uClipMin'), this.clipBox.min);
        gl.uniform3fv(u('uClipMax'), this.clipBox.max);
      } else {
        gl.uniform3f(u('uClipMin'), -1e9, -1e9, -1e9);
        gl.uniform3f(u('uClipMax'), 1e9, 1e9, 1e9);
      }
      gl.uniform3f(u('uLightDir'), 0.4, 0.8, 0.35);
      gl.uniform1i(u('uPickMode'), 0);
      gl.uniform1i(u('uHasDiff'), this.diffTexture && this.colorMode === 'diff' ? 1 : 0);
      // 采样器始终绑定：有差异用差异纹理，否则用 1x1 保底纹理
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.diffTexture ?? this.dummyDiffTex);
      gl.uniform1i(u('uDiffTex'), 0);
      const origin = loader!.collection.origin;
      gl.uniform3fv(u('uOrigin'), origin);
      const b = loader!.collection.bounds;
      gl.uniform1f(u('uMinElev'), b.min[1]);
      gl.uniform1f(u('uMaxElev'), b.max[1]);

      for (const node of nodes) {
        gl.bindVertexArray(node.vao);
        gl.uniform1ui(u('uPickBase'), node.pickBase);
        gl.drawArrays(gl.POINTS, 0, node.pointCount);
        drawnPoints += node.pointCount;
        drawnNodes++;
      }
      gl.bindVertexArray(null);
    }

    // 2) 覆盖物（测量线/剖切框）
    if (this.overlays.length) {
      this.renderOverlays(vp);
    }

    // 3) EDL 后处理到默认帧缓冲
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.edlProgram);
    const eu = (name: string) => gl.getUniformLocation(this.edlProgram, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets.colorTex);
    gl.uniform1i(eu('uColorTex'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.targets.depthTex);
    gl.uniform1i(eu('uDepthTex'), 1);
    gl.uniform2f(eu('uTexel'), 1 / this.targets.width, 1 / this.targets.height);
    gl.uniform1f(eu('uStrength'), this.settings.edlStrength);
    gl.uniform1f(eu('uRadius'), this.settings.edlRadius);
    gl.uniform3fv(eu('uBackground'), this.settings.background);
    gl.uniform1f(eu('uNear'), this.camera.near);
    gl.uniform1f(eu('uFar'), this.camera.far);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);

    // 统计
    const now = performance.now();
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.stats = {
      fps: avg > 0 ? Math.round(1000 / avg) : 0,
      frameMs: Math.round(now - t0),
      drawnPoints,
      drawnNodes,
      gpuMB: loader ? loader.loadedGpuBytes / 1048576 : 0,
    };
    this.renderCallback?.();
  }

  private renderOverlays(vp: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, 'uViewProj'), false, vp);
    gl.bindVertexArray(this.lineVao);
    gl.lineWidth(2);
    for (const line of this.overlays) {
      const verts: number[] = [];
      for (let i = 0; i < line.points.length - 1; i++) {
        verts.push(...line.points[i], ...line.points[i + 1]);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      gl.uniform4fv(gl.getUniformLocation(this.lineProgram, 'uColor'), line.color);
      gl.drawArrays(gl.LINES, 0, verts.length / 3);
    }
    gl.bindVertexArray(null);
  }

  /** 拾取：返回点线性编号（0 起），未命中返回 -1 */
  pick(ndcX: number, ndcY: number): number {
    if (!this.targets) return -1;
    const gl = this.gl;
    const px = Math.floor((ndcX * 0.5 + 0.5) * this.targets.width);
    const py = Math.floor((1 - (ndcY * 0.5 + 0.5)) * this.targets.height);
    const buf = new Float32Array(1);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.targets.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(px, py, 1, 1, gl.RED, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    // 纹理里存的是 id+1（0 留给背景），浮点读回后四舍五入
    const encoded = Math.round(buf[0]);
    return encoded > 0 ? encoded - 1 : -1;
  }

  /** 高分辨率截图：临时放大渲染目标，输出 PNG Blob */
  async captureHighRes(scale: number): Promise<Blob> {
    const oldW = this.canvas.width;
    const oldH = this.canvas.height;
    const w = Math.floor(oldW * scale);
    const h = Math.floor(oldH * scale);
    this.pointScale = scale;
    this.canvas.width = w;
    this.canvas.height = h;
    this.createTargets(w, h);
    // 同步渲染两帧，确保缓冲上传完成
    this.renderFrame();
    this.renderFrame();
    const blob = await new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('截图失败'))), 'image/png');
    });
    // 恢复
    this.pointScale = 1;
    this.canvas.width = oldW;
    this.canvas.height = oldH;
    this.createTargets(oldW, oldH);
    this.renderFrame();
    return blob;
  }

  dispose(): void {
    this.stop();
    const gl = this.gl;
    if (this.targets) {
      gl.deleteFramebuffer(this.targets.fbo);
      gl.deleteTexture(this.targets.colorTex);
      gl.deleteTexture(this.targets.depthTex);
      gl.deleteTexture(this.targets.pickTex);
    }
    if (this.diffTexture) gl.deleteTexture(this.diffTexture);
    gl.deleteTexture(this.dummyDiffTex);
    gl.deleteProgram(this.pointProgram);
    gl.deleteProgram(this.edlProgram);
    gl.deleteProgram(this.lineProgram);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteBuffer(this.lineBuf);
  }
}
