# syntax=docker/dockerfile:1

# Образ гри: один процес Node, який роздає зібраний клієнт і тримає WebSocket.
# Етапи: build збирає клієнт, deps ставить лише продакшн-залежності, runtime-base — це
# Node без npm; фінальний етап бере з них готове — без vite, typescript, eslint і playwright.
#
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t moba-arena .
#   docker run --rm -p 3000:3000 -e ALLOWED_ORIGINS=http://localhost:3000 moba-arena

# Версія Node — та сама, що в .nvmrc. Сервер запускає .ts напряму (type stripping).
ARG NODE_VERSION=24

# --- 1. Збірка клієнта ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# Спершу лише маніфести: шар з npm ci береться з кешу, доки не змінилися залежності.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
# Лише робочий простір client (vite + посилання на shared): кореневі dev-залежності
# (eslint, playwright, vitest) для збірки не потрібні.
# sed: lock-файл має бути без адрес реєстру ("resolved"), але npm install на машині з
# приватним реєстром дописує їх знову — тоді npm ci в образі падає з E401. Прибираємо
# такі рядки, і пакунки беруться з публічного реєстру; цілісність гарантує "integrity".
RUN sed -i '/"resolved": "http/d' package-lock.json \
 && npm ci --workspace client --include-workspace-root=false --no-audit --no-fund

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/
RUN npm run build --workspace client

# --- 2. Продакшн-залежності ----------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
# Лише server і те, від чого він залежить (ws, pino, zod, посилання на shared).
RUN sed -i '/"resolved": "http/d' package-lock.json \
 && npm ci --omit=dev --workspace server --include-workspace-root=false --no-audit --no-fund

# --- 3. Основа без зайвого ------------------------------------------------------------
# У готовому образі нічого не встановлюють, тож npm, yarn, corepack і заголовки C++
# лише займають місце (≈30 МБ) і збільшують поверхню атаки. Видалення в окремому шарі
# розмір не зменшило б, тому чистимо тут, а фінальний етап копіює вже чисту файлову систему.
FROM node:${NODE_VERSION}-alpine AS runtime-base
RUN rm -rf /usr/local/lib/node_modules /usr/local/include /usr/local/share /opt/yarn* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
      /root/.npm /tmp/* \
 # Каталог журналів створюємо заздалегідь і віддаємо користувачеві node:
 # новий том успадковує власника й права цього каталогу.
 && mkdir -p /data/logs /app \
 && chown -R node:node /data

# --- 4. Фінальний образ --------------------------------------------------------------
FROM scratch
COPY --from=runtime-base / /

ARG GIT_SHA=dev

LABEL org.opencontainers.image.title="moba-arena" \
      org.opencontainers.image.description="Multiplayer browser arena: Node game server + static client" \
      org.opencontainers.image.source="https://github.com/nekojidev/moba-arena" \
      org.opencontainers.image.url="https://github.com/nekojidev/moba-arena" \
      org.opencontainers.image.revision="${GIT_SHA}"

# HOST=0.0.0.0: у контейнері 127.0.0.1 недосяжний ззовні. LOG_DIR — том для журналів матчів.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_DIR=/data/logs \
    GIT_SHA=${GIT_SHA}

WORKDIR /app

# Розкладка робочих просторів зберігається: node_modules/@moba-arena/shared — це посилання
# на /app/shared. Type stripping відмовляється від файлів, що фізично лежать у node_modules,
# тому shared мусить бути справжнім каталогом поруч, а не копією всередині node_modules.
COPY --from=deps /app/node_modules node_modules/
COPY package.json ./
COPY shared/package.json shared/
COPY shared/src shared/src/
COPY server/package.json server/
COPY server/src server/src/
COPY --from=build /app/client/dist client/dist/

USER node
EXPOSE 3000
VOLUME ["/data/logs"]

# wget є в busybox — окремий curl не потрібен. 127.0.0.1, а не localhost: в Alpine
# localhost може розв'язатися в ::1, а сервер слухає IPv4.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

# Exec-форма: Node — процес 1 і сам отримує SIGTERM від docker stop.
# Через npm start або оболонку сигнал до нього не дійшов би.
CMD ["node", "server/src/index.ts"]
