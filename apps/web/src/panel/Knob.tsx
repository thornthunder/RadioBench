import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HOLD_MS } from './Key.tsx';

interface KnobProps {
  label: ReactNode;
  size?: 'small' | 'large' | 'dial';
  /** Where the knob stands between its end stops, 0–1; leave out for a knob that turns freely. */
  position?: number | null;
  /** Degrees the knob is dragged round for one click. */
  degreesPerClick?: number;
  /** Lights the lamp beside the knob. */
  lit?: boolean;
  /** Colour of the ring of light around a dial. */
  ring?: string;
  disabled?: boolean;
  /** Text shown under the label: what the knob is set to. */
  readout?: ReactNode;
  /** Called with the number of clicks turned: positive clockwise. */
  onTurn(clicks: number): void;
  onPress?(): void;
  onHold?(): void;
}

/** Travel between the end stops of a knob that has them, in degrees. */
const SWEEP = 270;

/**
 * A rotary control. It turns with the mouse wheel, by dragging it round, and with the arrow
 * keys; a click or tap without turning presses it, where it can be pressed.
 */
export function Knob(props: KnobProps) {
  const { degreesPerClick = 15, onTurn, onPress, onHold, disabled } = props;
  const element = useRef<HTMLDivElement>(null);
  const [turned, setTurned] = useState(0);
  const drag = useRef<{ angle: number; pending: number; moved: boolean; held: boolean } | null>(
    null,
  );
  const holdTimer = useRef<number | undefined>(undefined);
  // The handlers below are attached once; this keeps them calling the latest callbacks.
  const latest = useRef({ onTurn, disabled });
  latest.current = { onTurn, disabled };

  const turn = (clicks: number) => {
    if (latest.current.disabled || clicks === 0) return;
    setTurned((angle) => angle + clicks * degreesPerClick);
    latest.current.onTurn(clicks);
  };

  // React attaches wheel listeners as passive, which cannot stop the page from scrolling.
  useEffect(() => {
    const knob = element.current;
    if (!knob) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      turn(event.deltaY < 0 ? 1 : -1);
    };
    knob.addEventListener('wheel', onWheel, { passive: false });
    return () => knob.removeEventListener('wheel', onWheel);
    // turn() only reaches for refs and state setters, so the listener never goes stale.
  }, []);

  const angleTo = (event: React.PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (box.left + box.width / 2);
    const y = event.clientY - (box.top + box.height / 2);
    return (Math.atan2(y, x) * 180) / Math.PI;
  };

  const rotation =
    props.position === undefined || props.position === null
      ? turned
      : -SWEEP / 2 + Math.min(1, Math.max(0, props.position)) * SWEEP;

  return (
    <div className={`knob knob-${props.size ?? 'small'} ${disabled ? 'knob-disabled' : ''}`}>
      <div
        ref={element}
        className="knob-body"
        role="slider"
        aria-label={typeof props.label === 'string' ? props.label : undefined}
        aria-valuenow={
          props.position === undefined ? undefined : Math.round((props.position ?? 0) * 100)
        }
        tabIndex={disabled ? -1 : 0}
        style={
          props.ring
            ? { boxShadow: `0 0 0 0.25em ${props.ring}, 0 0 1.2em ${props.ring}` }
            : undefined
        }
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          // Capture keeps a drag going outside the knob. It is not always to be had, and the
          // knob still works without it.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // No capture, then.
          }
          drag.current = { angle: angleTo(event), pending: 0, moved: false, held: false };
          window.clearTimeout(holdTimer.current);
          if (onHold) {
            holdTimer.current = window.setTimeout(() => {
              if (!drag.current || drag.current.moved) return;
              drag.current.held = true;
              onHold();
            }, HOLD_MS);
          }
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state) return;
          const angle = angleTo(event);
          // The short way round, so that crossing ±180° does not count as a full turn back.
          const delta = ((angle - state.angle + 540) % 360) - 180;
          state.angle = angle;
          state.pending += delta;
          if (Math.abs(state.pending) > 4) state.moved = true;
          const clicks = Math.trunc(state.pending / degreesPerClick);
          if (clicks !== 0) {
            state.pending -= clicks * degreesPerClick;
            turn(clicks);
          }
        }}
        onPointerUp={() => {
          window.clearTimeout(holdTimer.current);
          const state = drag.current;
          drag.current = null;
          if (state && !state.moved && !state.held) onPress?.();
        }}
        onPointerCancel={() => {
          window.clearTimeout(holdTimer.current);
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') turn(1);
          else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') turn(-1);
          else if (event.key === 'Enter' || event.key === ' ') onPress?.();
          else return;
          event.preventDefault();
        }}
      >
        <div className="knob-cap" style={{ transform: `rotate(${rotation}deg)` }}>
          <span className="knob-mark" />
        </div>
      </div>
      <div className="knob-label">
        {props.lit !== undefined ? <span className={`lamp ${props.lit ? 'lamp-on' : ''}`} /> : null}
        {props.label}
      </div>
      {props.readout !== undefined ? <div className="knob-readout">{props.readout}</div> : null}
    </div>
  );
}
