import React, { useEffect, useRef, useState, useCallback } from "react";
import "./FlipCard.css";

const SLOP = { fine: 4, coarse: 8 };
const TILT_SPRING = { stiffness: 160, damping: 28, mass: 0.8 };
const LIFT_SPRING = { stiffness: 260, damping: 28, mass: 1 };
const FLING = 0.16;
const HISTORY_MS = 90;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snap = (deg: number) => Math.round(deg / 180) * 180;
const isBack = (deg: number) => Math.abs(Math.round(deg / 180)) % 2 === 1;

class PhysicalSpring {
  current: number;
  target: number;
  velocity: number;
  stiffness: number;
  damping: number;
  mass: number;
  precision: number;

  constructor(init: number, stiffness: number, damping: number, mass = 1, precision = 0.05) {
    this.current = init;
    this.target = init;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
    this.precision = precision;
  }

  jump(val: number) {
    this.current = val;
    this.target = val;
    this.velocity = 0;
  }

  setTarget(val: number) {
    this.target = val;
  }

  step(dt: number): boolean {
    const delta = this.current - this.target;
    if (Math.abs(delta) < this.precision && Math.abs(this.velocity) < this.precision) {
      this.current = this.target;
      this.velocity = 0;
      return true;
    }
    const springForce = -this.stiffness * delta;
    const dampingForce = -this.damping * this.velocity;
    const acceleration = (springForce + dampingForce) / this.mass;
    this.velocity += acceleration * dt;
    this.current += this.velocity * dt;
    return false;
  }
}

export interface FlipCardProps extends React.HTMLAttributes<HTMLDivElement> {
  front?: React.ReactNode;
  back?: React.ReactNode;
  flipped?: boolean;
  defaultFlipped?: boolean;
  onFlipChange?: (flipped: boolean) => void;
  axis?: "x" | "y";
  flipOnClick?: boolean;
  draggable?: boolean;
  dragDistance?: number;
  tilt?: boolean;
  tiltMax?: number;
  glare?: boolean;
  glareOpacity?: number;
  behindGlow?: boolean;
  behindGlowColor?: string;
  behindGlowSize?: string;
  borderColor?: string;
  hoverScale?: number;
  perspective?: number;
  stiffness?: number;
  damping?: number;
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  background?: string;
  color?: string;
  shadow?: boolean;
  shadowColor?: string;
  shadowOpacity?: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export const FlipCard: React.FC<FlipCardProps> = ({
  front = null,
  back = null,
  flipped,
  defaultFlipped = false,
  onFlipChange,
  axis = "y",
  flipOnClick = true,
  draggable = true,
  dragDistance = 0,
  tilt = true,
  tiltMax = 3.8,
  glare = true,
  glareOpacity = 0.015,
  behindGlow = true,
  behindGlowColor,
  behindGlowSize,
  borderColor = "transparent",
  hoverScale = 1,
  perspective = 1100,
  stiffness = 160,
  damping = 28,
  width = 240,
  height = 320,
  radius = 26,
  background = "transparent",
  color = "#f5f5f5",
  shadow = true,
  shadowColor = "#000000",
  shadowOpacity = 0.45,
  disabled = false,
  ariaLabel = "Flip card",
  className = "",
  style,
  ...restProps
}) => {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const controlled = flipped !== undefined;
  const [inner, setInner] = useState(defaultFlipped);
  const [dragging, setDragging] = useState(false);
  const shown = controlled ? !!flipped : inner;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const [facingBack, setFacingBack] = useState(shown);

  const rootRef = useRef<HTMLDivElement>(null);
  const rotorRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLSpanElement>(null);

  const pointerPos = useRef({ x: 0.5, y: 0.5 });

  const grip = useRef<{
    id: number;
    x: number;
    y: number;
    base: number;
    moved: boolean;
    slop: number;
    hist: Array<{ t: number; v: number }>;
  } | null>(null);

  // Springs (仅负责翻转与微光)
  const turnSpring = useRef(new PhysicalSpring(shown ? 180 : 0, stiffness, damping, 1, 0.05));
  const sheenSpring = useRef(new PhysicalSpring(0, LIFT_SPRING.stiffness, LIFT_SPRING.damping, LIFT_SPRING.mass, 0.005));

  // ProfileCard 一阶惯性阻尼滤波器（严格遵循用户源码机制，带有真实物理延迟，杜绝鼠标移上瞬态剧烈颠簸）
  const inertial = useRef({
    currentX: 0.5,
    currentY: 0.5,
    targetX: 0.5,
    targetY: 0.5,
    currentTiltX: 0,
    currentTiltY: 0,
    initialUntil: 0,
    active: false,
  });

  const targetDeg = useRef(shown ? 180 : 0);
  const rafId = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);

  // 更新 DOM transform 与阴影（不做任何放大或抬起，纯做 3D 偏移倾角与延迟惯性反馈）
  const renderTransforms = useCallback((tX = 0, tY = 0, px = 0.5, py = 0.5) => {
    const turn = turnSpring.current.current;

    const sumX = turn + tX;
    const sumY = turn + tY;

    if (rotorRef.current) {
      if (axis === "x") {
        rotorRef.current.style.transform = `perspective(${perspective}px) rotateY(${tY.toFixed(2)}deg) rotateX(${sumX.toFixed(2)}deg)`;
      } else {
        rotorRef.current.style.transform = `perspective(${perspective}px) rotateX(${tX.toFixed(2)}deg) rotateY(${sumY.toFixed(2)}deg)`;
      }
    }

    if (shadowRef.current) {
      const facing = Math.abs(Math.cos((turn * Math.PI) / 180));
      const spread = 0.08 + 0.92 * facing;
      const shade = 0.1 + 0.9 * facing * facing;
      const baseShadow = axis === "x" ? `scaleY(${spread.toFixed(3)})` : `scaleX(${spread.toFixed(3)})`;
      
      // ProfileCard 物理光照模型：根据鼠标光源位置反向拉扯阴影，凸显立体悬浮厚度
      const sOffsetX = ((px - 0.5) * -16);
      const sOffsetY = ((py - 0.5) * -20 + 8);

      shadowRef.current.style.transform = `${baseShadow} translate3d(${sOffsetX.toFixed(1)}px, ${sOffsetY.toFixed(1)}px, 0)`;
      shadowRef.current.style.opacity = shade.toFixed(3);
    }

    const currentIsBack = isBack(turn);
    if (currentIsBack !== shownRef.current) {
      setFacingBack(currentIsBack);
    }
  }, [axis, perspective]);

  // 动画循环（每帧执行一阶低通滤波：k = 1 - Math.exp(-dt / tau)）
  const startLoop = useCallback(() => {
    if (rafId.current !== null) return;
    lastTime.current = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - (lastTime.current || now)) / 1000, 0.032);
      lastTime.current = now;

      // 惯性平滑阻尼：进入时使用 0.38s 沉稳缓入，巡航时使用 0.16s 柔性滞后，离开时 0.22s 优雅回正
      const ine = inertial.current;
      const tau = !ine.active ? 0.22 : (now < ine.initialUntil ? 0.38 : 0.16);
      const k = 1 - Math.exp(-dt / tau);

      ine.currentX += (ine.targetX - ine.currentX) * k;
      ine.currentY += (ine.targetY - ine.currentY) * k;

      const tX = tilt && !reduceMotion ? (0.5 - ine.currentY) * 2 * tiltMax : 0;
      const tY = tilt && !reduceMotion ? (ine.currentX - 0.5) * 2 * tiltMax : 0;

      const settledTurn = turnSpring.current.step(dt);
      const settledSheen = sheenSpring.current.step(dt);

      const inertialSettled = !ine.active &&
        Math.abs(ine.currentX - 0.5) < 0.001 &&
        Math.abs(ine.currentY - 0.5) < 0.001;

      if (inertialSettled) {
        ine.currentX = 0.5;
        ine.currentY = 0.5;
      }

      // 同步通过惯性坐标更新 CSS 变量（流光和阴影与倾斜严格保持同相位延迟）
      if (rootRef.current) {
        const pctX = (ine.currentX * 100).toFixed(2);
        const pctY = (ine.currentY * 100).toFixed(2);
        rootRef.current.style.setProperty("--pointer-x", `${pctX}%`);
        rootRef.current.style.setProperty("--pointer-y", `${pctY}%`);
        rootRef.current.style.setProperty("--pointer-from-left", ine.currentX.toFixed(4));
        rootRef.current.style.setProperty("--pointer-from-top", ine.currentY.toFixed(4));
        rootRef.current.style.setProperty("--fc-sheen", sheenSpring.current.current.toFixed(3));
      }

      renderTransforms(tX, tY, ine.currentX, ine.currentY);

      if (settledTurn && settledSheen && inertialSettled) {
        rafId.current = null;
        lastTime.current = null;
        const finalBack = isBack(turnSpring.current.current);
        if (finalBack !== shownRef.current) {
          shownRef.current = finalBack;
          if (!controlled) setInner(finalBack);
          onFlipChange?.(finalBack);
        }
      } else {
        rafId.current = requestAnimationFrame(loop);
      }
    };

    rafId.current = requestAnimationFrame(loop);
  }, [controlled, onFlipChange, reduceMotion, renderTransforms, tilt, tiltMax]);

  const settle = useCallback((to: number, _velocity = 0, instant = false) => {
    targetDeg.current = to;
    if (instant || reduceMotion) {
      turnSpring.current.jump(to);
      const ine = inertial.current;
      const tX = tilt && !reduceMotion ? (0.5 - ine.currentY) * 2 * tiltMax : 0;
      const tY = tilt && !reduceMotion ? (ine.currentX - 0.5) * 2 * tiltMax : 0;
      renderTransforms(tX, tY, ine.currentX, ine.currentY);
      const next = isBack(to);
      if (next !== shownRef.current) {
        shownRef.current = next;
        setFacingBack(next);
        if (!controlled) setInner(next);
        onFlipChange?.(next);
      }
    } else {
      turnSpring.current.setTarget(to);
      startLoop();
    }
  }, [controlled, onFlipChange, reduceMotion, renderTransforms, startLoop]);

  const flip = useCallback((instant = false) => {
    const base = snap(turnSpring.current.current);
    settle(isBack(base) ? base - 180 : base + 180, 0, instant);
  }, [settle]);

  const rest = useCallback(() => {
    const ine = inertial.current;
    ine.targetX = 0.5;
    ine.targetY = 0.5;
    ine.active = false;
    sheenSpring.current.setTarget(0);
    if (rootRef.current) {
      rootRef.current.style.setProperty("--card-opacity", "0");
    }
    startLoop();
  }, [startLoop]);

  // 受控属性 flipped 监听
  useEffect(() => {
    if (!controlled) return;
    const currentIsBack = isBack(targetDeg.current);
    if (currentIsBack === flipped) return;
    const base = targetDeg.current;
    const nextTarget = isBack(base) ? base - 180 : base + 180;
    targetDeg.current = nextTarget;
    if (reduceMotion) {
      turnSpring.current.jump(nextTarget);
      renderTransforms();
      setFacingBack(flipped);
    } else {
      turnSpring.current.setTarget(nextTarget);
      startLoop();
    }
  }, [controlled, flipped, reduceMotion, renderTransforms, startLoop]);

  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

  useEffect(() => {
    if (disabled) rest();
  }, [disabled, rest]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || grip.current) return;
    if (!draggable) return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}

    grip.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      base: turnSpring.current.current,
      moved: false,
      slop: e.pointerType === "touch" ? SLOP.coarse : SLOP.fine,
      hist: []
    };

    if (!reduceMotion) {
      startLoop();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (g && g.id === e.pointerId) {
      const d = axis === "x" ? e.clientY - g.y : e.clientX - g.x;
      if (!g.moved) {
        if (Math.abs(d) < g.slop || !draggable || reduceMotion) return;
        g.moved = true;
        setDragging(true);
        sheenSpring.current.jump(0);
      }
      const span = dragDistance > 0 ? dragDistance : axis === "x" ? (typeof height === "number" ? height : 320) : (typeof width === "number" ? width : 240);
      const deg = g.base + (axis === "x" ? -1 : 1) * (d / span) * 180;
      turnSpring.current.jump(deg);
      const ine = inertial.current;
      const tX = tilt && !reduceMotion ? (0.5 - ine.currentY) * 2 * tiltMax : 0;
      const tY = tilt && !reduceMotion ? (ine.currentX - 0.5) * 2 * tiltMax : 0;
      renderTransforms(tX, tY, ine.currentX, ine.currentY);

      const now = performance.now();
      g.hist.push({ t: now, v: deg });
      while (g.hist.length > 2 && now - g.hist[0].t > HISTORY_MS) g.hist.shift();
      return;
    }

    if (disabled || e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = clamp((e.clientX - r.left) / r.width, 0, 1);
    const py = clamp((e.clientY - r.top) / r.height, 0, 1);

    const ine = inertial.current;
    ine.targetX = px;
    ine.targetY = py;
    ine.active = true;

    if (rootRef.current) {
      rootRef.current.style.setProperty("--card-opacity", "1");
    }
    if (!reduceMotion) {
      sheenSpring.current.setTarget(1);
    }
    startLoop();
  };

  const release = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    grip.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}
    setDragging(false);

    if (e.pointerType === "touch" || !rootRef.current?.matches(":hover")) rest();

    if (!g.moved) {
      if (!cancelled && flipOnClick) flip(false);
      else settle(targetDeg.current, 0, false);
      return;
    }

    const here = turnSpring.current.current;
    let velocity = 0;
    const a = g.hist[0];
    const b = g.hist[g.hist.length - 1];
    if (!cancelled && a && b && b.t > a.t && performance.now() - b.t < 60) {
      velocity = ((b.v - a.v) / (b.t - a.t)) * 1000;
    }
    const to = cancelled ? snap(g.base) : clamp(snap(here + velocity * FLING), snap(here) - 180, snap(here) + 180);
    settle(to, velocity, false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (!e.repeat && flipOnClick) flip(true);
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!disabled && flipOnClick && e.detail === 0) flip(true);
  };

  const widthCss = typeof width === "number" ? `${width}px` : width;
  const heightCss = typeof height === "number" ? `${height}px` : height;
  const radiusCss = typeof radius === "number" ? `${radius}px` : radius;

  return (
    <div
      ref={rootRef}
      role="region"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={`flip-card${className ? ` ${className}` : ""}`}
      data-axis={axis}
      data-draggable={draggable && !disabled && !reduceMotion ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      data-fade={reduceMotion ? (shown ? "back" : "front") : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={e => release(e, false)}
      onPointerCancel={e => release(e, true)}
      onLostPointerCapture={e => release(e, true)}
      onPointerEnter={e => {
        if (e.pointerType !== "touch" && !disabled) {
          const r = e.currentTarget.getBoundingClientRect();
          const px = clamp((e.clientX - r.left) / r.width, 0, 1);
          const py = clamp((e.clientY - r.top) / r.height, 0, 1);

          const ine = inertial.current;
          ine.targetX = px;
          ine.targetY = py;
          ine.active = true;
          // ProfileCard 机制：进入时赋予 800ms 强惯性缓入期（INITIAL_TAU = 0.55），带有柔顺的物理延迟，绝不一放上去就剧烈颠簸
          ine.initialUntil = performance.now() + 800;

          if (rootRef.current) {
            rootRef.current.style.setProperty("--card-opacity", "1");
          }
          if (!reduceMotion) {
            sheenSpring.current.setTarget(1);
          }
          startLoop();
        }
      }}
      onPointerLeave={() => {
        if (!grip.current) rest();
      }}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onDragStart={e => e.preventDefault()}
      style={{
        width: widthCss,
        height: heightCss,
        borderRadius: radiusCss,
        ["--fc-w" as string]: widthCss,
        ["--fc-h" as string]: heightCss,
        ["--fc-radius" as string]: radiusCss,
        ["--fc-bg" as string]: background,
        ["--fc-ink" as string]: color,
        ["--fc-shadow" as string]: shadowColor,
        ["--fc-shadow-o" as string]: shadowOpacity,
        ["--fc-glare" as string]: glareOpacity,
        ["--fc-behind-glow" as string]: behindGlowColor,
        ["--fc-behind-glow-size" as string]: behindGlowSize,
        ["--fc-border" as string]: borderColor,
        ...style
      }}
      {...restProps}
    >
      {/* ProfileCard 风格：背部漫反射光源，凸显卡片边缘与空间投影 */}
      {behindGlow ? (
        <span
          className="flip-card__behind-glow"
          aria-hidden="true"
        />
      ) : null}

      {/* 物理动态阴影 */}
      {shadow ? (
        <span
          ref={shadowRef}
          className="flip-card__shadow"
          aria-hidden="true"
        />
      ) : null}

      {/* 3D 转子容器 */}
      <div ref={rotorRef} className="flip-card__rotor">
        <div
          className="flip-card__face flip-card__face--front"
          aria-hidden={facingBack}
          {...({ inert: facingBack ? "" : undefined } as Record<string, unknown>)}
        >
          {front}
          {glare ? <span className="flip-card__glare" aria-hidden="true" /> : null}
        </div>
        <div
          className="flip-card__face flip-card__face--back"
          aria-hidden={!facingBack}
          {...({ inert: !facingBack ? "" : undefined } as Record<string, unknown>)}
        >
          {back}
          {glare ? <span className="flip-card__glare" aria-hidden="true" /> : null}
        </div>
      </div>
    </div>
  );
};

export default FlipCard;
