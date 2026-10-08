import { useRef, type ReactNode } from 'react';

/** How long a key must be held for its second function, as on the radio. */
export const HOLD_MS = 600;

interface KeyProps {
  children: ReactNode;
  /** Lights the key's lamp, in the given colour. */
  lit?: boolean | 'red' | 'orange' | 'green';
  disabled?: boolean;
  title?: string;
  className?: string;
  onPress?(): void;
  /** Called once the key has been held down for HOLD_MS; the press is then not reported. */
  onHold?(): void;
  /** Called when a held key is let go. */
  onRelease?(): void;
}

/** A front-panel key: pressed briefly for one function, held for another. */
export function Key(props: KeyProps) {
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);

  const cancel = () => window.clearTimeout(timer.current);
  const lamp = props.lit === true ? 'lit' : props.lit || '';

  return (
    <button
      type="button"
      className={`key ${lamp ? `key-${lamp}` : ''} ${props.className ?? ''}`}
      disabled={props.disabled}
      title={props.title}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        held.current = false;
        cancel();
        if (!props.onHold) return;
        timer.current = window.setTimeout(() => {
          held.current = true;
          props.onHold?.();
        }, HOLD_MS);
      }}
      onPointerUp={() => {
        cancel();
        if (held.current) props.onRelease?.();
      }}
      onPointerLeave={() => {
        cancel();
        if (held.current) props.onRelease?.();
        held.current = false;
      }}
      onClick={() => {
        // A hold has already done its work; the click that ends it is not a press.
        if (held.current) held.current = false;
        else props.onPress?.();
      }}
    >
      {props.children}
    </button>
  );
}
