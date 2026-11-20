// Вимірювання часу гарячих ділянок: simulate, render, decode, reconcile — і часу кадру.
//
// Два рівні:
//  • завжди — тривалості складаються в кільцеві Float32Array (жодних нових об'єктів на замір,
//    тож сам вимірювач не створює роботи збирачу сміття);
//  • з ?perf=marks — додатково performance.mark/measure, щоб ділянки було видно на доріжці
//    Timings у профайлері Chrome. Вони створюють об'єкти на кожен замір, тому лише за прапорцем.

export type PerfSection = 'simulate' | 'render' | 'decode' | 'reconcile';

const SECTIONS: readonly PerfSection[] = ['simulate', 'render', 'decode', 'reconcile'];
const CAPACITY = 4096; // замірів на ділянку; для кадрів — близько хвилини при 60 Гц

interface Ring {
  readonly values: Float32Array;
  count: number; // скільки записано всього (може бути більше за місткість)
}

export interface Percentiles {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface PerfReport {
  readonly frame: Percentiles;
  readonly sections: Record<PerfSection, Percentiles>;
}

function ring(): Ring {
  return { values: new Float32Array(CAPACITY), count: 0 };
}

function push(target: Ring, value: number): void {
  target.values[target.count % CAPACITY] = value;
  target.count += 1;
}

function percentiles(source: Ring): Percentiles {
  const samples = Math.min(source.count, CAPACITY);
  const sorted = source.values.slice(0, samples).sort();
  const at = (fraction: number): number =>
    sorted[Math.min(samples - 1, Math.floor(samples * fraction))] ?? 0;
  return { samples, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[samples - 1] ?? 0 };
}

export interface Perf {
  begin(): number;
  end(section: PerfSection, startedAt: number): void;
  frame(deltaMs: number): void;
  reset(): void;
  report(): PerfReport;
}

export function createPerf({ marks = false }: { marks?: boolean } = {}): Perf {
  const frames = ring();
  const sections: Record<PerfSection, Ring> = {
    simulate: ring(),
    render: ring(),
    decode: ring(),
    reconcile: ring(),
  };

  return {
    begin: () => performance.now(),

    end(section, startedAt) {
      const now = performance.now();
      push(sections[section], now - startedAt);
      if (marks) performance.measure(section, { start: startedAt, end: now });
    },

    // Час між двома кадрами — те саме число, що показує HUD (Lab 1).
    frame(deltaMs) {
      push(frames, deltaMs);
    },

    reset() {
      frames.count = 0;
      for (const section of SECTIONS) sections[section].count = 0;
    },

    report() {
      return {
        frame: percentiles(frames),
        sections: {
          simulate: percentiles(sections.simulate),
          render: percentiles(sections.render),
          decode: percentiles(sections.decode),
          reconcile: percentiles(sections.reconcile),
        },
      };
    },
  };
}
