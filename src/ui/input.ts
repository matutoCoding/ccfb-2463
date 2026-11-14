// 画布输入：左键旋转 / 右键平移 / 滚轮缩放 / 触屏，单击（无拖动）触发拾取
import type { OrbitCamera } from '../core/camera';

export interface InputHandlers {
  onPick?: (ndcX: number, ndcY: number, x: number, y: number) => void;
}

export function attachInput(
  canvas: HTMLCanvasElement,
  camera: OrbitCamera,
  handlers: InputHandlers,
): () => void {
  let dragging: 'rotate' | 'pan' | null = null;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = false;

  const ndc = (clientX: number, clientY: number): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [
      ((clientX - r.left) / r.width) * 2 - 1,
      -(((clientY - r.top) / r.height) * 2 - 1),
    ];
  };

  const onDown = (e: MouseEvent): void => {
    canvas.focus();
    dragging = e.button === 2 || e.button === 1 ? 'pan' : 'rotate';
    lastX = downX = e.clientX;
    lastY = downY = e.clientY;
    moved = false;
  };
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragging === 'rotate') camera.rotate(dx, dy);
    else camera.pan(dx / canvas.clientWidth, dy / canvas.clientHeight);
  };
  const onUp = (e: MouseEvent): void => {
    if (!moved && e.button === 0) {
      const [x, y] = ndc(e.clientX, e.clientY);
      handlers.onPick?.(x, y, e.clientX, e.clientY);
    }
    dragging = null;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    camera.dolly(Math.exp(e.deltaY * 0.0012));
  };
  const onContext = (e: Event): void => e.preventDefault();

  // 触屏
  let touchMode: 'rotate' | 'pan' | 'pinch' | null = null;
  let pinchDist = 0;
  const tDist = (t: TouchList) => {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
  };
  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length === 1) {
      touchMode = 'rotate';
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      downX = lastX; downY = lastY; moved = false;
    } else if (e.touches.length === 2) {
      touchMode = 'pinch';
      pinchDist = tDist(e.touches);
    }
  };
  const onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    if (touchMode === 'rotate' && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - lastX;
      const dy = t.clientY - lastY;
      if (Math.abs(t.clientX - downX) + Math.abs(t.clientY - downY) > 8) moved = true;
      lastX = t.clientX; lastY = t.clientY;
      camera.rotate(dx, dy);
    } else if (touchMode === 'pinch' && e.touches.length === 2) {
      const d = tDist(e.touches);
      if (pinchDist > 0) camera.dolly(pinchDist / d);
      pinchDist = d;
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (lastX) camera.pan((cx - lastX) / canvas.clientWidth, (cy - lastY) / canvas.clientHeight);
      lastX = cx; lastY = cy;
    }
  };
  const onTouchEnd = (e: TouchEvent): void => {
    if (touchMode === 'rotate' && !moved && e.changedTouches.length === 1) {
      const [x, y] = ndc(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      handlers.onPick?.(x, y, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    touchMode = null;
  };

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);

  return () => {
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('touchend', onTouchEnd);
  };
}
