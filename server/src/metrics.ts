// Метрики для /metrics у текстовому форматі Prometheus. Написано вручну, без prom-client:
// формат — це рядки «ім'я{мітки} значення», а нам потрібні лише лічильники й показники.
//
// Лічильники (…_total) НАКОПИЧУВАЛЬНІ: швидкість рахує той, хто збирає (rate() у Prometheus).
// Для людини, яка дивиться очима, поруч є готові «за секунду» — їх раз на секунду рахує
// таймер нижче (різниця лічильників за останню секунду).

import { performance } from 'node:perf_hooks';

// Чому сервер відмовив з'єднанню або обірвав його. Кожна причина — окрема мітка reason.
export const REJECTION_REASONS = [
  'bad_message', // не JSON, не та форма, зіпсований бінарний кадр
  'unknown_type',
  'bad_version',
  'rate_limit',
  'join_timeout',
  'room_not_found',
  'room_full',
  'join_rejected', // решта відмов входу (матч не запущено тощо)
  'origin_rejected', // Origin не зі списку ALLOWED_ORIGINS
  'ip_limit', // забагато з'єднань з однієї адреси
  'slow_client',
  'oversize', // кадр більший за MAX_PAYLOAD_BYTES
  'heartbeat_lost', // клієнт зник і не відповідає на ping
  'shutting_down', // сервер зупиняється і нових не приймає
  'not_found', // WebSocket не на /ws
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface RoomTickMetrics {
  readonly room: string;
  readonly players: number;
  readonly tick: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
  // Запізнення початку кроку відносно розкладу (мс): росте, коли цикл подій зайнятий чужою
  // роботою, навіть якщо сам крок рахується так само швидко.
  readonly lateP50: number;
  readonly lateP99: number;
  readonly overruns: number;
}

// Те, що метрики не рахують самі, а питають в інших частин сервера в момент запиту.
export interface MetricsSources {
  readonly version: string;
  readonly connections: number;
  readonly players: number;
  readonly rooms: number;
  readonly ready: boolean;
  readonly uptimeSeconds: number;
  // Тривалість кроку всіх матчів разом і кожної кімнати окремо (мс).
  readonly tickAll: { readonly p50: number; readonly p99: number };
  readonly ticks: readonly RoomTickMetrics[];
}

export interface Metrics {
  reject(reason: RejectionReason): void;
  messageIn(bytes: number): void;
  bytesOut(bytes: number): void;
  accepted(): void;
  dropped(): void;
  rejections(): Readonly<Record<RejectionReason, number>>;
  render(sources: MetricsSources): string;
  close(): void;
}

// Значення мітки в лапках: \ " і перенос рядка екрануються (так вимагає формат).
function label(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function zeroRejections(): Record<RejectionReason, number> {
  return {
    bad_message: 0,
    unknown_type: 0,
    bad_version: 0,
    rate_limit: 0,
    join_timeout: 0,
    room_not_found: 0,
    room_full: 0,
    join_rejected: 0,
    origin_rejected: 0,
    ip_limit: 0,
    slow_client: 0,
    oversize: 0,
    heartbeat_lost: 0,
    shutting_down: 0,
    not_found: 0,
  };
}

export function createMetrics({ sampleMs = 1000 }: { sampleMs?: number } = {}): Metrics {
  const rejected = zeroRejections();
  const totals = { messagesIn: 0, bytesIn: 0, bytesOut: 0, accepted: 0, dropped: 0 };
  // Показники «за секунду»: значення лічильників на момент попереднього відліку й результат.
  let previous = { ...totals, at: performance.now() };
  let rates = { messagesIn: 0, bytesIn: 0, bytesOut: 0 };
  let loop = performance.eventLoopUtilization();
  let utilization = 0;

  const sampler = setInterval(() => {
    const at = performance.now();
    const seconds = Math.max(0.001, (at - previous.at) / 1000);
    rates = {
      messagesIn: (totals.messagesIn - previous.messagesIn) / seconds,
      bytesIn: (totals.bytesIn - previous.bytesIn) / seconds,
      bytesOut: (totals.bytesOut - previous.bytesOut) / seconds,
    };
    previous = { ...totals, at };
    // eventLoopUtilization(попередній відлік) — частка часу, коли цикл подій був зайнятий
    // САМЕ за цей проміжок (0…1), а не від старту процесу.
    const now = performance.eventLoopUtilization();
    utilization = performance.eventLoopUtilization(now, loop).utilization;
    loop = now;
  }, sampleMs);
  sampler.unref(); // відлік метрик не тримає процес живим

  function render(sources: MetricsSources): string {
    const lines: string[] = [];
    const metric = (
      name: string,
      type: 'counter' | 'gauge',
      help: string,
      samples: readonly (readonly [labels: string, value: number])[],
    ): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) {
        lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`);
      }
    };
    const single = (name: string, type: 'counter' | 'gauge', help: string, value: number): void =>
      metric(name, type, help, [['', value]]);
    const round = (value: number): number => Number(value.toFixed(3));

    metric('moba_build_info', 'gauge', 'Версія сервера (git SHA) у мітці version', [
      [`{version="${label(sources.version)}"}`, 1],
    ]);
    single('moba_up_seconds', 'gauge', 'Скільки секунд працює процес', sources.uptimeSeconds);
    single(
      'moba_ready',
      'gauge',
      '1 — сервер приймає гравців, 0 — зупиняється',
      sources.ready ? 1 : 0,
    );
    single('moba_connections', 'gauge', 'Відкриті WebSocket-з’єднання', sources.connections);
    single('moba_players', 'gauge', 'Гравці в кімнатах (з’єднання після join)', sources.players);
    single('moba_rooms', 'gauge', 'Кімнати', sources.rooms);
    single('moba_matches', 'gauge', 'Матчі, що йдуть просто зараз', sources.ticks.length);

    single(
      'moba_connections_accepted_total',
      'counter',
      'Прийняті WebSocket-з’єднання від старту',
      totals.accepted,
    );
    single('moba_messages_in_total', 'counter', 'Отримані повідомлення', totals.messagesIn);
    single('moba_bytes_in_total', 'counter', 'Отримані байти (вміст кадрів)', totals.bytesIn);
    single('moba_bytes_out_total', 'counter', 'Надіслані байти (вміст кадрів)', totals.bytesOut);
    single(
      'moba_messages_dropped_total',
      'counter',
      'Некритичні кадри, не надіслані повільним клієнтам',
      totals.dropped,
    );
    single(
      'moba_messages_in_per_second',
      'gauge',
      'Повідомлень за секунду (остання секунда)',
      round(rates.messagesIn),
    );
    single(
      'moba_bytes_in_per_second',
      'gauge',
      'Вхідних байтів за секунду (остання секунда)',
      round(rates.bytesIn),
    );
    single(
      'moba_bytes_out_per_second',
      'gauge',
      'Вихідних байтів за секунду (остання секунда)',
      round(rates.bytesOut),
    );

    metric(
      'moba_rejections_total',
      'counter',
      'Відмови й примусові розриви за причиною',
      REJECTION_REASONS.map((reason) => [`{reason="${reason}"}`, rejected[reason]]),
    );

    metric(
      'moba_tick_duration_ms',
      'gauge',
      'Тривалість кроку симуляції, мс: квантилі за останні кроки (вікно — ?window=N)',
      [
        ['{room="*",quantile="0.5"}', sources.tickAll.p50],
        ['{room="*",quantile="0.99"}', sources.tickAll.p99],
        ...sources.ticks.flatMap((room): (readonly [string, number])[] => [
          [`{room="${label(room.room)}",quantile="0.5"}`, room.p50],
          [`{room="${label(room.room)}",quantile="0.99"}`, room.p99],
          [`{room="${label(room.room)}",quantile="1"}`, room.max],
        ]),
      ],
    );
    metric(
      'moba_tick_lateness_ms',
      'gauge',
      'Запізнення початку кроку відносно розкладу, мс (те саме вікно)',
      sources.ticks.flatMap((room): (readonly [string, number])[] => [
        [`{room="${label(room.room)}",quantile="0.5"}`, room.lateP50],
        [`{room="${label(room.room)}",quantile="0.99"}`, room.lateP99],
      ]),
    );
    metric(
      'moba_room_players',
      'gauge',
      'Гравці-люди в кімнаті з матчем',
      sources.ticks.map((room) => [`{room="${label(room.room)}"}`, room.players]),
    );
    metric(
      'moba_room_ticks_total',
      'counter',
      'Номер кроку матчу в кімнаті',
      sources.ticks.map((room) => [`{room="${label(room.room)}"}`, room.tick]),
    );
    metric(
      'moba_tick_overruns_total',
      'counter',
      'Скільки разів матч безнадійно відстав і пропустив кроки',
      sources.ticks.map((room) => [`{room="${label(room.room)}"}`, room.overruns]),
    );

    single(
      'moba_event_loop_utilization',
      'gauge',
      'Частка часу, коли цикл подій був зайнятий (0…1, остання секунда)',
      round(utilization),
    );
    const memory = process.memoryUsage();
    single('moba_memory_rss_bytes', 'gauge', 'Пам’ять процесу (RSS)', memory.rss);
    single('moba_memory_heap_used_bytes', 'gauge', 'Зайнята купа V8', memory.heapUsed);
    single('moba_memory_heap_total_bytes', 'gauge', 'Розмір купи V8', memory.heapTotal);

    return lines.join('\n') + '\n';
  }

  return {
    reject(reason) {
      rejected[reason] += 1;
    },
    messageIn(bytes) {
      totals.messagesIn += 1;
      totals.bytesIn += bytes;
    },
    bytesOut(bytes) {
      totals.bytesOut += bytes;
    },
    accepted() {
      totals.accepted += 1;
    },
    dropped() {
      totals.dropped += 1;
    },
    rejections: () => ({ ...rejected }),
    render,
    close() {
      clearInterval(sampler);
    },
  };
}
