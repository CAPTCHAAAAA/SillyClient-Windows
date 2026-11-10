import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getGuideSteps, type GuidePlatform, type GuideStep } from "./guide-content";
import { completeOnboardingOperation, notifyOnboardingStarted } from "./onboarding-runtime";
import { sameGeometry, useOnboardingTarget, type TargetGeometry } from "./useOnboardingTarget";
import { getCalloutPosition, getViewportBounds } from "./onboarding-viewport";
import "./OnboardingGuide.css";

interface OnboardingGuideProps {
  isLight: boolean;
  platform: GuidePlatform;
  onComplete: () => void;
  onSkip: () => void;
  onStepChange: (step: GuideStep) => void;
}

interface PointerSession {
  pointerId: number;
  stepId: string;
  target: Element;
  startX: number;
  startY: number;
  moved: boolean;
  activated: boolean;
  released: boolean;
  cancelled: boolean;
}

interface Presentation {
  index: number;
  geometry: TargetGeometry;
}

const TARGET_GAP = 18;
const CALLOUT_WIDTH = 292;

function getEventElement(target: EventTarget | null) {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

export default function OnboardingGuide({
  isLight,
  platform,
  onComplete,
  onSkip,
  onStepChange,
}: OnboardingGuideProps) {
  const steps = useMemo(() => getGuideSteps(platform), [platform]);
  const [targetIndex, setTargetIndex] = useState(0);
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [settledStepId, setSettledStepId] = useState<string | null>(null);
  const [calloutHeight, setCalloutHeight] = useState(132);
  const [closing, setClosing] = useState(false);
  const calloutRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const currentIndexRef = useRef(0);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const advanceFrameRef = useRef<number | null>(null);
  const dropTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pendingAdvanceRef = useRef(false);
  const closingRef = useRef(false);
  const startedRef = useRef(false);
  const prepareStepRef = useRef(onStepChange);
  prepareStepRef.current = onStepChange;

  const targetStep = steps[targetIndex];
  const currentIndex = presentation?.index ?? targetIndex;
  const step = steps[currentIndex];
  const transitioning = !presentation || targetIndex !== currentIndex;
  const targetGeometry = presentation?.geometry ?? null;
  const {
    targetRef: targetElementRef,
    targetGeometry: measuredGeometry,
    viewportBounds,
    tracking,
    ready,
  } = useOnboardingTarget(targetStep.target, targetStep.id);
  const inputReady = !transitioning && ready && !tracking && settledStepId === step.id;

  useEffect(() => {
    if (!inputReady || startedRef.current) return;
    startedRef.current = true;
    notifyOnboardingStarted();
  }, [inputReady]);

  useLayoutEffect(() => {
    if (!presentation || transitioning || !ready || tracking) {
      setSettledStepId((current) => current === step.id ? null : current);
      return;
    }
    let frameId: number | null = null;
    const startedAt = performance.now();
    const waitForSpotlight = () => {
      const moving = ringRef.current?.getAnimations().some((animation) =>
        animation.playState === "running" || animation.pending,
      );
      if (moving && performance.now() - startedAt < 900) {
        frameId = window.requestAnimationFrame(waitForSpotlight);
      } else {
        setSettledStepId(step.id);
      }
    };
    frameId = window.requestAnimationFrame(waitForSpotlight);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [presentation?.geometry, presentation?.index, ready, step.id, tracking, transitioning]);

  useLayoutEffect(() => {
    prepareStepRef.current(targetStep);
  }, [targetStep]);

  useLayoutEffect(() => {
    pointerSessionRef.current = null;
    if (dropTimerRef.current !== null) {
      window.clearTimeout(dropTimerRef.current);
      dropTimerRef.current = null;
    }
    setSettledStepId(null);
  }, [targetIndex]);

  useLayoutEffect(() => {
    if (!measuredGeometry) {
      const session = pointerSessionRef.current;
      if (session && (
        session.stepId !== targetStep.id
        || session.target !== targetElementRef.current
        || !session.target.isConnected
      )) {
        session.cancelled = true;
      }
      setSettledStepId((current) => current === targetStep.id ? null : current);
      return;
    }
    if (transitioning && !ready) return;
    currentIndexRef.current = targetIndex;
    if (transitioning) pendingAdvanceRef.current = false;
    setPresentation((previous) =>
      previous?.index === targetIndex && sameGeometry(previous.geometry, measuredGeometry)
        ? previous
        : { index: targetIndex, geometry: measuredGeometry },
    );
  }, [measuredGeometry, presentation?.index, ready, targetIndex, targetElementRef, targetStep.id, transitioning]);

  useLayoutEffect(() => {
    const callout = calloutRef.current;
    if (!callout) return;
    const measure = () => {
      const height = Math.round(callout.getBoundingClientRect().height);
      if (height > 0) {
        setCalloutHeight((current) => Math.abs(current - height) > 1 ? height : current);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(callout);
    measure();
    return () => observer.disconnect();
  }, [Boolean(presentation)]);

  const requestClose = useCallback((complete: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      (complete ? onComplete : onSkip)();
    }, 220);
  }, [onComplete, onSkip]);

  const advance = useCallback(() => {
    if (closingRef.current || pendingAdvanceRef.current) return;
    pendingAdvanceRef.current = true;
    if (steps[currentIndexRef.current]?.id === "launch-progress") completeOnboardingOperation();
    if (currentIndexRef.current >= steps.length - 1) {
      requestClose(true);
    } else {
      setTargetIndex(currentIndexRef.current + 1);
    }
  }, [requestClose, steps]);

  const scheduleAdvance = useCallback((event?: Event) => {
    if (closingRef.current || pendingAdvanceRef.current) return;
    pendingAdvanceRef.current = true;
    advanceFrameRef.current = window.requestAnimationFrame(() => {
      advanceFrameRef.current = null;
      pendingAdvanceRef.current = false;
      if (!event?.defaultPrevented) advance();
    });
  }, [advance]);

  const hasPendingCardMotion = () => document.querySelector(
    [
      '[data-reordering="true"]',
      '[data-dropping="true"]',
      '[data-reorder-committing="true"]',
      '[data-carousel-committing="true"]',
      '[data-carousel-click-blocked="true"]',
    ].join(", "),
  );

  useEffect(() => {
    const previousDocumentOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      document.documentElement.style.overflow = previousDocumentOverflow;
      document.body.style.overflow = previousBodyOverflow;
      if (advanceFrameRef.current !== null) window.cancelAnimationFrame(advanceFrameRef.current);
      if (dropTimerRef.current !== null) window.clearTimeout(dropTimerRef.current);
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const getValidSession = () => {
      const session = pointerSessionRef.current;
      if (!session || session.cancelled) return null;
      if (
        closingRef.current
        || pendingAdvanceRef.current
        || session.stepId !== step.id
        || session.stepId !== targetStep.id
        || session.target !== targetElementRef.current
        || !session.target.isConnected
      ) {
        session.cancelled = true;
        return null;
      }
      return session;
    };

    const isSessionTarget = (eventTarget: EventTarget | null, session: PointerSession) => {
      const element = getEventElement(eventTarget);
      return Boolean(element && (element === session.target || session.target.contains(element)));
    };

    const isAllowedTarget = (eventTarget: EventTarget | null) => {
      const element = getEventElement(eventTarget);
      if (!element) return false;
      if (element.closest(".sc-onboarding-skip")) return true;
      if (closingRef.current || pendingAdvanceRef.current || !inputReady) return false;
      const target = targetElementRef.current;
      return Boolean(target && (element === target || target.contains(element)));
    };

    const blockEvent = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const isCardControl = () => {
      const target = targetElementRef.current;
      return step.interaction !== "drag"
        && target?.matches("button")
        && Boolean(target.closest("[data-instance-id]"));
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) {
        if (pointerSessionRef.current) pointerSessionRef.current.cancelled = true;
        blockEvent(event);
        return;
      }
      if (!isAllowedTarget(event.target)) {
        pointerSessionRef.current = null;
        blockEvent(event);
        return;
      }
      if (getEventElement(event.target)?.closest(".sc-onboarding-skip")) return;
      const target = targetElementRef.current;
      if (!target) return;
      pointerSessionRef.current = {
        pointerId: event.pointerId,
        stepId: step.id,
        target,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        activated: false,
        released: false,
        cancelled: false,
      };
      if (isCardControl()) event.stopPropagation();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const session = getValidSession();
      if (session?.pointerId === event.pointerId && !session.released) {
        if (session.target.matches('[data-reordering="true"]')) session.activated = true;
        if (Math.hypot(
          event.clientX - session.startX,
          event.clientY - session.startY,
        ) > 7) {
          session.moved = true;
        }
        if (isCardControl()) event.stopPropagation();
        return;
      }
      if (!isAllowedTarget(event.target)) {
        blockEvent(event);
      } else if (isCardControl()) {
        event.stopPropagation();
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const session = getValidSession();
      if (session?.pointerId === event.pointerId && !session.released) {
        session.released = true;
        session.moved ||= Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > 7;
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const releasedInside = hit === session.target || Boolean(hit && session.target.contains(hit));
        if (step.interaction !== "drag") session.cancelled ||= !releasedInside;
        if (
          step.interaction === "drag"
          && !session.cancelled
          && session.moved
          && (step.id !== "card-reorder" || session.activated)
        ) {
          if (step.id === "card-reorder") {
            const startedAt = performance.now();
            const waitForDrop = () => {
              if (closingRef.current) return;
              if (hasPendingCardMotion() && performance.now() - startedAt < 5000) {
                dropTimerRef.current = window.setTimeout(waitForDrop, 32);
              } else {
                scheduleAdvance();
              }
            };
            dropTimerRef.current = window.setTimeout(waitForDrop, 32);
          } else {
            scheduleAdvance();
          }
        } else if (session.moved && session.target.matches("[data-instance-id], [data-create-card]")) {
          const startedAt = performance.now();
          const restoreTarget = () => {
            if (closingRef.current || currentIndexRef.current !== currentIndex) return;
            if (hasPendingCardMotion() && performance.now() - startedAt < 5000) {
              dropTimerRef.current = window.setTimeout(restoreTarget, 32);
            } else {
              prepareStepRef.current(step);
            }
          };
          dropTimerRef.current = window.setTimeout(restoreTarget, 32);
        }
        if (isCardControl()) event.stopPropagation();
        return;
      }
      if (!isAllowedTarget(event.target)) {
        blockEvent(event);
      } else if (isCardControl()) {
        event.stopPropagation();
      }
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const session = pointerSessionRef.current;
      if (session?.pointerId === event.pointerId && !session.released) {
        session.cancelled = true;
        session.released = true;
      }
    };

    const handleClick = (event: MouseEvent) => {
      const session = getValidSession();
      const completedSessionClick = Boolean(
        event.detail !== 0
        && session?.released
        && !session.moved
        && isSessionTarget(event.target, session),
      );
      if (!isAllowedTarget(event.target) && !completedSessionClick) {
        blockEvent(event);
        return;
      }
      if (getEventElement(event.target)?.closest(".sc-onboarding-skip")) return;
      pointerSessionRef.current = null;
      if (
        step.interaction === "drag"
        || event.button !== 0
        || (event.detail !== 0 && (
          !session
          || session.stepId !== step.id
          || !session.released
          || session.cancelled
          || session.moved
        ))
      ) {
        blockEvent(event);
        return;
      }
      scheduleAdvance(event);
    };

    const handleWheel = (event: WheelEvent) => {
      if (!isAllowedTarget(event.target)) blockEvent(event);
    };

    const handleTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        if (pointerSessionRef.current) pointerSessionRef.current.cancelled = true;
        blockEvent(event);
        return;
      }
      const session = getValidSession();
      if (session && isSessionTarget(event.target, session)) {
        if (step.interaction === "drag") event.preventDefault();
        return;
      }
      if (!isAllowedTarget(event.target)) blockEvent(event);
    };

    const handleMouseDown = (event: MouseEvent) => {
      const session = getValidSession();
      const sessionTarget = session && !session.moved && isSessionTarget(event.target, session);
      if (event.button !== 0 || (!isAllowedTarget(event.target) && !sessionTarget)) blockEvent(event);
    };

    const handleContextMenu = (event: MouseEvent) => {
      blockEvent(event);
    };

    const cancelPointerSession = () => {
      if (pointerSessionRef.current) pointerSessionRef.current.cancelled = true;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        blockEvent(event);
        requestClose(false);
      } else if (event.key !== "Tab" && !isAllowedTarget(event.target)) {
        blockEvent(event);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerCancel, true);
    document.addEventListener("lostpointercapture", handlePointerCancel, true);
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("touchstart", handleTouch, { capture: true, passive: false });
    document.addEventListener("touchmove", handleTouch, { capture: true, passive: false });
    document.addEventListener("touchend", handleTouch, { capture: true, passive: false });
    document.addEventListener("click", handleClick, true);
    document.addEventListener("auxclick", handleContextMenu, true);
    document.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    document.addEventListener("contextmenu", handleContextMenu, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", cancelPointerSession);
    document.addEventListener("visibilitychange", cancelPointerSession);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", handlePointerCancel, true);
      document.removeEventListener("lostpointercapture", handlePointerCancel, true);
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("touchstart", handleTouch, true);
      document.removeEventListener("touchmove", handleTouch, true);
      document.removeEventListener("touchend", handleTouch, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("auxclick", handleContextMenu, true);
      document.removeEventListener("wheel", handleWheel, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", cancelPointerSession);
      document.removeEventListener("visibilitychange", cancelPointerSession);
    };
  }, [currentIndex, inputReady, requestClose, scheduleAdvance, step, targetElementRef, targetStep.id]);

  if (!step) return null;

  const spotlightStyle = targetGeometry
    ? {
      left: targetGeometry.left,
      top: targetGeometry.top,
      width: targetGeometry.width,
      height: targetGeometry.height,
      borderRadius: targetGeometry.radius,
    }
    : undefined;

  const calloutPosition = targetGeometry
    ? getCalloutPosition(
      targetGeometry,
      CALLOUT_WIDTH,
      calloutHeight,
      viewportBounds ?? getViewportBounds(window.visualViewport, window.innerWidth, window.innerHeight),
      TARGET_GAP,
    )
    : null;

  return (
    <div
      data-onboarding-step={step.id}
      data-onboarding-pending={!inputReady ? targetStep.id : undefined}
      className={`sc-onboarding ${isLight ? "is-light" : "is-dark"}${tracking && !transitioning && step.interaction === "drag" ? " is-tracking" : ""}${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="使用引导"
      aria-busy={!inputReady}
    >
      <svg
        className={`sc-onboarding-backdrop${targetGeometry ? "" : " is-hidden"}`}
        aria-hidden="true"
      >
        <defs>
          <mask id="sc-spotlight-mask">
            <rect width="100%" height="100%" fill="#ffffff" />
            {targetGeometry && (
              <rect
                className="sc-onboarding-mask-hole"
                x={targetGeometry.left}
                y={targetGeometry.top}
                width={targetGeometry.width}
                height={targetGeometry.height}
                rx={targetGeometry.radius}
                ry={targetGeometry.radius}
                style={{
                  x: `${targetGeometry.left}px`,
                  y: `${targetGeometry.top}px`,
                  width: `${targetGeometry.width}px`,
                  height: `${targetGeometry.height}px`,
                  rx: `${targetGeometry.radius}px`,
                  ry: `${targetGeometry.radius}px`,
                }}
                fill="#000000"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="var(--spotlight-shade)"
          mask="url(#sc-spotlight-mask)"
        />
      </svg>

      <div
        ref={ringRef}
        className={`sc-onboarding-ring${targetGeometry ? "" : " is-hidden"}`}
        style={spotlightStyle}
        aria-hidden="true"
      />

      {presentation && <div
        ref={calloutRef}
        className="sc-onboarding-callout"
        style={calloutPosition ?? undefined}
        aria-live="polite"
      >
        <div className="sc-onboarding-callout-meta">
          练习模式 · {String(currentIndex + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
        </div>
        <h2>{step.title}</h2>
        <p>{step.summary}</p>
        <span className="sc-onboarding-callout-hint">
          {step.interaction === "drag" ? "拖动高亮区域继续" : "点击高亮区域继续"}
        </span>
      </div>}

      <button
        type="button"
        className="sc-onboarding-skip"
        onClick={() => requestClose(false)}
        aria-label="跳过使用引导"
      >
        跳过
      </button>
    </div>
  );
}
