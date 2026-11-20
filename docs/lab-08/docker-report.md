# Образ контейнера (Lab 8)

Виміряно 2026-11-20 на Docker 29.7.2 (linux/arm64, macOS). Образ зібрано з робочого дерева на коміті `400f2d289d720972b910d2177a74171cae1532a0`; порт 3000 на машині був зайнятий, тому контейнер опубліковано на 3080. Нічого нікуди не розгорнуто й не надіслано в реєстр.

```sh
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t moba-arena:lab8 .
docker run -d --name moba-final -p 3080:3000 -e ALLOWED_ORIGINS=http://localhost:3080 moba-arena:lab8
```

## Як зібрано

| Етап           | Що робить                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `build`        | `node:24-alpine`, `npm ci -w client` (vite), `vite build` → `client/dist`                          |
| `deps`         | `npm ci --omit=dev -w server` → лише `ws`, `pino`, `zod` та їхні залежності                        |
| `runtime-base` | `node:24-alpine` без npm, npx, yarn, corepack і заголовків C++                                     |
| фінальний      | `FROM scratch` + файлова система `runtime-base`, `node_modules`, `shared`, `server`, `client/dist` |

Маніфести пакунків копіюються раніше за код, тому зміна коду не перевстановлює залежності. У фінальному образі немає ні npm, ні збирача: Node запускає `server/src/index.ts` напряму. `node_modules/@moba-arena/shared` — посилання на `/app/shared`, як і в репозиторії.

## Розмір

```
$ docker image ls moba-arena:lab8
IMAGE             ID             DISK USAGE   CONTENT SIZE
moba-arena:lab8   f2353dbc9f17        215MB         58.5MB
$ docker image inspect moba-arena:lab8 --format '{{.Size}}'
58505567
$ docker export <контейнер> | wc -c
152617472
```

| Що міряємо                                            | Розмір               |
| ----------------------------------------------------- | -------------------- |
| стиснуті шари — саме стільки їде в реєстр і з реєстру | 58,5 МБ              |
| розпакована файлова система (`docker export`)         | 152,6 МБ (145,5 МіБ) |
| колонка DISK USAGE у Docker 29                        | 215 МБ               |

Чесне застереження: вимогу «менше 200 МБ» образ виконує за розпакованим розміром (152,6 МБ) і за стиснутим (58,5 МБ), але не за колонкою DISK USAGE. Docker 29 зі сховищем containerd показує в ній місце на диску: стиснуті шари разом із розпакованими (58,5 + 152,6 ≈ 211 МБ плюс службові дані). Старіші версії Docker показували в колонці SIZE лише розпаковане.

З чого складаються 152,6 МБ: сам файл `node` — 122,3 МБ, Alpine — близько 9 МБ, `node_modules` — 11,0 МБ, клієнт — 0,5 МБ, код сервера і `shared` — 0,35 МБ. Без етапу `runtime-base` образ був 252 МБ у DISK USAGE і 63,9 МБ стиснутим (близько 188 МБ розпакованим).

## Версія, користувач, залежності

```
$ curl -s http://localhost:3080/health
{"status":"ok","version":"400f2d289d720972b910d2177a74171cae1532a0","ready":true,"uptime":4,"rooms":3,"connections":0,"droppedMessages":0,"openLogs":0,"rss":107749376}
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:3080/ready
200
$ docker exec moba-final id
uid=1000(node) gid=1000(node) groups=1000(node)
$ docker exec moba-final sh -c 'cat /proc/1/cmdline | tr "\0" " "'
node server/src/index.ts
$ docker exec moba-final sh -c 'ls node_modules | grep -c vite'
0
$ docker exec moba-final ls node_modules
@moba-arena @pinojs atomic-sleep on-exit-leak-free pino pino-abstract-transport pino-std-serializers
process-warning quick-format-unescaped real-require safe-stable-stringify sonic-boom split2 thread-stream ws zod
```

`version` збігається з `GIT_SHA`, переданим під час збирання. Каталогів `typescript`, `eslint`, `@playwright`, `vitest` у `node_modules` немає, команд `npm`, `npx`, `yarn` в образі немає. `/data/logs` належить `node` і доступний для запису; у `/app` користувач писати не може (`touch /app/x` → Permission denied).

## HEALTHCHECK

```
$ docker inspect --format '{{.State.Health.Status}}' moba-final
healthy
```

Перевірка — `wget` із busybox на `http://127.0.0.1:$PORT/health` кожні 30 с. Перші 10 с вона йде щосекунди (`--start-interval=1s`), тому статус `healthy` з'явився вже за секунду після старту, а не через 30 с.

## WebSocket і перевірка Origin

Клієнт на `ws` підключався до `ws://localhost:3080/ws` і надсилав `join` у кімнату `mid`:

| Заголовок Origin        | Результат                             |
| ----------------------- | ------------------------------------- |
| `http://localhost:3080` | 101, прийшов `welcome` із `playerId`  |
| `http://evil.example`   | HTTP 403                              |
| без заголовка           | HTTP 403 (`ALLOW_NO_ORIGIN` вимкнено) |

Після цього `/metrics` показує `moba_rejections_total{reason="origin_rejected"} 2`.

## docker stop

Клієнт зайшов у кімнату, через 3 с — `time docker stop moba-final`:

```
docker stop moba-final  0.01s user 0.01s system 11% cpu 0.148 total
$ docker inspect --format '{{.State.ExitCode}}' moba-final
0
```

Що побачив клієнт (час від запуску клієнта):

```
    9 ms open
   11 ms welcome
 2995 ms message {"v":1,"type":"shutdown","reason":"server is shutting down"} (after 89 binary snapshots)
 2997 ms close code=1001 reason="server is shutting down"
```

Кінець `docker logs`:

```
{"level":"info","time":"2026-11-20T19:32:55.031Z","playerId":"ac037f51","roomId":"mid","name":"stopper","code":1001,"msg":"player left"}
{"level":"info","time":"2026-11-20T19:32:55.032Z","roomId":"mid","file":"/data/logs/mid-20261120T193252045Z-2.ndjson","msg":"match log closed"}
{"level":"info","time":"2026-11-20T19:32:55.052Z","tookMs":23,"msg":"bye"}
```

Зупинка зайняла 0,15 с проти 10 с, які Docker дає до SIGKILL: сигнал доходить до Node, бо `CMD` записано в exec-формі й Node — процес 1.

## docker compose

`GIT_SHA=$(git rev-parse HEAD) GAME_PORT=3081 docker compose up -d --build`: контейнер `healthy` через 5 с, `/health` показує той самий SHA, перевірка Origin дає ті самі 101 / 403 / 403. У compose додано `init: true` (процес 1 — `docker-init`, який пересилає сигнали), кореневу файлову систему лише для читання, `cap_drop: ALL` і том `match-logs` для журналів. `docker compose stop` з підключеним клієнтом — 0,25 с, код виходу 0, клієнт отримав `shutdown` і 1001, останній рядок логу — `bye`.

## Що варто знати

- У `package-lock.json` зараз є 13 рядків `"resolved"` з адресою приватного реєстру (їх дописав `npm install` на машині розробника). З ними `npm ci` в образі падав із E401. Dockerfile прибирає такі рядки перед `npm ci`, тож образ збирається; пакунки перевіряються за `integrity`. Сам lock-файл варто почистити окремо: `npm ci` у CI на GitHub (не перевірялося) найімовірніше впаде так само, бо доступу до приватного реєстру там немає.
- Виміри зроблено для arm64. Реліз збирає amd64, розмір там може відрізнятися на кілька мегабайтів.
- Версії базового образу закріплено лише за мажорною (`node:24-alpine`).
