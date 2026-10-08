import { useEffect, useState } from 'react';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';

// The meter is a needle over two arcs, as on the radio: S units above, a transmit scale below.
const PIVOT_X = 110;
const PIVOT_Y = 142;
const LEFT_DEGREES = 146;
const SWEEP_DEGREES = 112;
const S_RADIUS = 112;
const TX_RADIUS = 92;

// Where the S-meter's marks fall in the radio's 0–255 reading. These follow the calibration
// commonly used for this family of radios and are approximate, not measured on an FT-710.
const S_MARKS: [label: string, reading: number][] = [
  ['1', 12],
  ['3', 40],
  ['5', 65],
  ['7', 95],
  ['9', 130],
  ['+20', 172],
  ['+40', 220],
  ['+60', 255],
];
// The transmit scale is drawn as on the radio but is not calibrated at all.
const PO_MARKS: [label: string, at: number][] = [
  ['0', 0.04],
  ['10', 0.24],
  ['50', 0.47],
  ['100', 0.67],
  ['150', 0.84],
];

function point(fraction: number, radius: number): [number, number] {
  const angle = ((LEFT_DEGREES - fraction * SWEEP_DEGREES) * Math.PI) / 180;
  return [PIVOT_X + radius * Math.cos(angle), PIVOT_Y - radius * Math.sin(angle)];
}

function arc(radius: number, from: number, to: number): string {
  const [x1, y1] = point(from, radius);
  const [x2, y2] = point(to, radius);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`;
}

/** The S-meter in receive, the selected transmit meter in transmit. Touch it to choose which. */
export function Meter() {
  const { state, subscribeScope } = useRadio();
  const { show } = useUi();
  // The scope stream carries the S-meter 30 times a second, far smoother than polling it.
  const [streamed, setStreamed] = useState<number | null>(null);

  useEffect(() => {
    let last = 0;
    const unsubscribe = subscribeScope((frame) => {
      last = performance.now();
      setStreamed(frame.sMeter);
    });
    // When the stream stops, fall back to the polled reading.
    const timer = window.setInterval(() => {
      if (performance.now() - last > 1000) setStreamed(null);
    }, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [subscribeScope]);

  const transmitting = state?.transmitting ?? false;
  const txMeter = state?.txMeter ?? 'PO';
  const txReading = {
    PO: state?.meterPo,
    COMP: state?.meterComp,
    ALC: state?.meterAlc,
    VDD: state?.meterVdd,
    ID: state?.meterId,
    SWR: state?.meterSwr,
  }[txMeter];
  const reading = transmitting ? (txReading ?? 0) : (streamed ?? state?.sMeter ?? 0);
  const [needleX, needleY] = point(reading / 255, S_RADIUS + 6);
  const [baseX, baseY] = point(reading / 255, 38);

  return (
    <button
      type="button"
      className="meter"
      onClick={() => show('meter')}
      title="Choose the transmit meter"
    >
      <svg
        viewBox="0 0 220 96"
        role="img"
        aria-label={transmitting ? `${txMeter} meter` : 'S-meter'}
      >
        <path d={arc(S_RADIUS, 0, 130 / 255)} className="meter-arc" />
        <path d={arc(S_RADIUS, 130 / 255, 1)} className="meter-arc meter-over" />
        <path d={arc(TX_RADIUS, 0, 1)} className="meter-arc meter-tx" />
        <text x="4" y="30" className="meter-name">
          S
        </text>
        {S_MARKS.map(([label, at]) => {
          const [x, y] = point(at / 255, S_RADIUS + 11);
          const [tx1, ty1] = point(at / 255, S_RADIUS - 3);
          const [tx2, ty2] = point(at / 255, S_RADIUS + 3);
          return (
            <g key={label}>
              <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} className="meter-tick" />
              <text
                x={x}
                y={y}
                className={label.startsWith('+') ? 'meter-mark meter-over' : 'meter-mark'}
              >
                {label}
              </text>
            </g>
          );
        })}
        <text x="213" y="26" className="meter-unit meter-over">
          dB
        </text>
        {PO_MARKS.map(([label, at]) => {
          const [x, y] = point(at, TX_RADIUS - 11);
          return (
            <text key={label} x={x} y={y} className="meter-mark meter-small">
              {label}
            </text>
          );
        })}
        <text x="14" y="88" className="meter-unit">
          {txMeter}
        </text>
        <text x="204" y="80" className="meter-unit">
          {txMeter === 'PO' ? 'W' : ''}
        </text>
        <line x1={baseX} y1={baseY} x2={needleX} y2={needleY} className="meter-needle" />
        {state?.hiSwr ? (
          <text x="110" y="92" className="meter-warning">
            HI-SWR
          </text>
        ) : null}
      </svg>
    </button>
  );
}
