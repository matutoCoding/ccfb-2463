// 轨道相机：左键旋转、右键平移、滚轮推拉，触屏单指旋转/双指缩放平移
import { invertMat4, mat4LookAt, mat4Multiply, mat4Perspective, v3, type Mat4, type Vec3 } from './math';

export interface CameraPose {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  distance = 10;
  yaw = 0.7;
  pitch = 0.4;
  fovy = Math.PI / 4;
  near = 0.01;
  far = 1000;
  minDistance = 0.001;
  private baseRadius: number | null = null;

  private aspect = 1;
  private view: Mat4 | null = null;
  private proj: Mat4 | null = null;
  private viewProj: Mat4 | null = null;
  private invViewProj: Mat4 | null = null;
  private eye: Vec3 = [0, 0, 0];

  setAspect(a: number): void {
    this.aspect = a;
    this.dirty();
  }

  fit(bounds: { min: Vec3; max: Vec3 }, aspect: number): void {
    const center: Vec3 = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const size = v3.sub(bounds.max, bounds.min);
    const radius = Math.max(v3.len(size) / 2, 1e-4);
    this.baseRadius = radius;
    this.target = center;
    this.yaw = Math.PI * 0.25;
    this.pitch = Math.PI * 0.18;
    // 让包围球完整入镜
    const halfFov = this.fovy / 2;
    const fitDist = (radius / Math.sin(halfFov)) * 1.15;
    this.distance = fitDist / Math.min(1, aspect);
    // near/far 紧贴观察范围，比值控制在 ~100 以内，避免非线性深度把整个场景
    // 压到 far 平面附近（NDC z≈1）导致 EDL 误判背景、深度冲突
    this.near = Math.max(radius / 200, fitDist / 50);
    this.far = fitDist * 3 + radius * 2;
    this.minDistance = radius / 500;
    this.dirty();
  }

  getPose(): CameraPose {
    return {
      target: v3.clone(this.target),
      distance: this.distance,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  setPose(p: CameraPose): void {
    this.target = v3.clone(p.target);
    this.distance = p.distance;
    this.yaw = p.yaw;
    this.pitch = p.pitch;
    this.dirty();
  }

  getEye(): Vec3 {
    this.ensure();
    return v3.clone(this.eye);
  }

  getViewProj(): Mat4 {
    this.ensure();
    return this.viewProj!;
  }

  getInvViewProj(): Mat4 {
    this.ensure();
    return this.invViewProj!;
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.pitch -= dy * 0.005;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    this.dirty();
  }

  pan(dxScreen: number, dyScreen: number): void {
    this.ensure();
    const right: Vec3 = [this.view![0], this.view![4], this.view![8]];
    const up: Vec3 = [this.view![1], this.view![5], this.view![9]];
    const scale = this.distance * Math.tan(this.fovy / 2) * 2;
    const move = v3.add(
      v3.scale(right, (-dxScreen * scale) / this.aspect * 0.5),
      v3.scale(up, (dyScreen * scale) * 0.5),
    );
    this.target = v3.add(this.target, move);
    this.dirty();
  }

  dolly(factor: number): void {
    this.distance = Math.max(this.minDistance, this.distance * factor);
    // 跟随观察距离收紧 near/far，保持深度精度（比值 ~100 以内）
    const r = this.baseRadius ?? this.distance;
    this.near = Math.max(this.minDistance * 0.5, this.distance / 50);
    this.far = this.distance * 3 + r * 2;
    this.dirty();
  }

  /** 屏幕 NDC 坐标发出的射线（原点+方向） */
  screenRay(ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
    this.ensure();
    const near = unprojectSafe(this.invViewProj!, [ndcX, ndcY, -1]);
    const far = unprojectSafe(this.invViewProj!, [ndcX, ndcY, 1]);
    return {
      origin: near,
      dir: v3.norm(v3.sub(far, near)),
    };
  }

  private dirty(): void {
    this.view = this.proj = this.viewProj = this.invViewProj = null;
  }

  private ensure(): void {
    if (this.viewProj) return;
    const cp = Math.cos(this.pitch);
    this.eye = [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
    this.view = mat4LookAt(this.eye, this.target, [0, 1, 0]);
    this.proj = mat4Perspective(this.fovy, this.aspect, this.near, this.far);
    this.viewProj = mat4Multiply(this.proj, this.view);
    this.invViewProj = invertMat4(this.viewProj);
  }
}

function unprojectSafe(inv: Mat4, ndc: Vec3): Vec3 {
  const x = ndc[0], y = ndc[1], z = ndc[2];
  const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  return [
    (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / w,
    (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / w,
    (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / w,
  ];
}
