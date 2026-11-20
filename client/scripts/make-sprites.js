// Генерує джерела спрайтшитів (SVG) і atlas.json.
//
//   npm run make-sprites
//
// PNG у public/assets/sprites/ — це ті самі SVG, відрендерені в браузері з прозорим тлом
// (art/*.svg → *.png). Після зміни малюнка PNG треба експортувати заново.

import { mkdirSync, writeFileSync } from 'node:fs';

const HERO = 192; // розмір клітинки аркуша героїв, px (2 px на одиницю світу)
const CELL = 128; // розмір клітинки аркуша об'єктів, px

const TEAMS = {
  green: {
    cloak: '#1f8f6a',
    cloakDark: '#14604a',
    body: '#3fd6a3',
    bodyLight: '#b7ffe3',
    face: '#e6fff5',
  },
  red: {
    cloak: '#a8342c',
    cloakDark: '#6f201b',
    body: '#e2574c',
    bodyLight: '#ffc2bb',
    face: '#ffe9e6',
  },
};

function hero(team, thrust, index) {
  const c = TEAMS[team];
  const id = `${team}${thrust ? 'T' : ''}`;
  const flame = thrust
    ? `<polygon points="-14,-9 -44,0 -14,9" fill="url(#flame-${id})"/>
       <polygon points="-14,-5 -32,0 -14,5" fill="#ffffff" opacity="0.7"/>`
    : '';
  return `
  <g transform="translate(${index * HERO + HERO / 2} ${HERO / 2}) scale(2)">
    <defs>
      <radialGradient id="body-${id}" cx="35%" cy="35%" r="75%">
        <stop offset="0" stop-color="${c.bodyLight}"/><stop offset="0.55" stop-color="${c.body}"/>
        <stop offset="1" stop-color="${c.cloak}"/>
      </radialGradient>
      <linearGradient id="flame-${id}" x1="1" x2="0">
        <stop offset="0" stop-color="#78dcff" stop-opacity="0.95"/>
        <stop offset="1" stop-color="#78dcff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${flame}
    <polygon points="6,-15 -24,-11 -17,0 -24,11 6,15" fill="${c.cloak}" stroke="${c.cloakDark}" stroke-width="1.5" stroke-linejoin="round"/>
    <polygon points="2,-9 -18,-7 -13,0 -18,7 2,9" fill="${c.cloakDark}" opacity="0.6"/>
    <circle cx="0" cy="-12" r="4.5" fill="${c.cloakDark}"/>
    <circle cx="0" cy="12" r="4.5" fill="${c.cloakDark}"/>
    <circle r="13" fill="url(#body-${id})" stroke="${c.cloakDark}" stroke-width="1.2"/>
    <circle cx="5" cy="0" r="6" fill="${c.face}"/>
    <circle cx="7.5" cy="-2.2" r="1.2" fill="#1b2a22"/>
    <circle cx="7.5" cy="2.2" r="1.2" fill="#1b2a22"/>
    <line x1="-8" y1="17" x2="24" y2="17" stroke="#c9a25a" stroke-width="3" stroke-linecap="round"/>
    <circle cx="27" cy="17" r="8" fill="#7ef0ff" opacity="0.3"/>
    <circle cx="27" cy="17" r="5" fill="#7ef0ff" stroke="#e8fdff" stroke-width="1"/>
  </g>`;
}

function cellCenter(index) {
  return [(index % 4) * CELL + CELL / 2, Math.floor(index / 4) * CELL + CELL / 2];
}

function golem(index, seeking) {
  const [cx, cy] = cellCenter(index);
  const points = [];
  for (let i = 0; i < 11; i += 1) {
    const wobble = 0.84 + 0.16 * Math.sin(i * 2.4 + 1);
    const angle = (i / 11) * Math.PI * 2;
    points.push(
      `${(Math.cos(angle) * 56 * wobble).toFixed(1)},${(Math.sin(angle) * 56 * wobble).toFixed(1)}`,
    );
  }
  const rock = seeking ? ['#8a6fa3', '#4b3a5c', '#e07bff'] : ['#9a9f93', '#565a52', '#f2c14e'];
  const id = seeking ? 'gh' : 'g';
  return `
  <g transform="translate(${cx} ${cy})">
    <defs><radialGradient id="rock-${id}" cx="35%" cy="30%" r="80%">
      <stop offset="0" stop-color="${rock[0]}"/><stop offset="1" stop-color="${rock[1]}"/>
    </radialGradient></defs>
    <polygon points="${points.join(' ')}" fill="url(#rock-${id})" stroke="${seeking ? rock[2] : '#c3c8bb'}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M-30,-18 L-8,-6 L-14,16 M10,-34 L16,-12 L36,-4 M-4,30 L12,22" fill="none" stroke="${rock[1]}" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
    <circle cx="16" cy="2" r="15" fill="${rock[2]}" opacity="0.25"/>
    <circle cx="16" cy="2" r="9" fill="${rock[2]}"/>
    <circle cx="19" cy="2" r="3.5" fill="#1b1b1b"/>
  </g>`;
}

function rune(index, color, symbol) {
  const [cx, cy] = cellCenter(index);
  return `
  <g transform="translate(${cx} ${cy})">
    <circle r="58" fill="${color}" opacity="0.12"/>
    <polygon points="0,-48 48,0 0,48 -48,0" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="5" stroke-linejoin="round"/>
    <polygon points="0,-30 30,0 0,30 -30,0" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2"/>
    ${symbol}
  </g>`;
}

function bolt(index, color) {
  const [cx, cy] = cellCenter(index);
  const id = `bolt-${index}`;
  return `
  <g transform="translate(${cx} ${cy})">
    <defs><linearGradient id="${id}" x1="1" x2="0">
      <stop offset="0" stop-color="${color}" stop-opacity="0.8"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,-11 -60,0 0,11" fill="url(#${id})"/>
    <circle r="22" fill="${color}" opacity="0.3"/>
    <circle r="16" fill="${color}"/>
    <circle cx="3" cy="-3" r="7" fill="#ffffff" opacity="0.85"/>
  </g>`;
}

const svg = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}\n</svg>\n`;

const heroNames = ['hero-green', 'hero-green-thrust', 'hero-red', 'hero-red-thrust'];
const heroes = svg(
  HERO * 4,
  HERO,
  hero('green', false, 0) + hero('green', true, 1) + hero('red', false, 2) + hero('red', true, 3),
);

const white =
  'fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
const objectNames = [
  'golem',
  'golem-homing',
  'rune-shield',
  'rune-rapid',
  'rune-homing',
  'bolt-green',
  'bolt-red',
  'bolt-homing',
];
const objectRadius = [50, 50, 48, 48, 48, 16, 16, 16];
const objects = svg(
  CELL * 4,
  CELL * 2,
  golem(0, false) +
    golem(1, true) +
    rune(
      2,
      '#6fc3ff',
      `<path d="M0,-18 L15,-10 L15,4 Q15,16 0,22 Q-15,16 -15,4 L-15,-10 Z" ${white}/>`,
    ) +
    rune(3, '#ffb347', `<path d="M4,-22 L-10,2 L0,2 L-4,22 L10,-2 L0,-2 Z" ${white}/>`) +
    rune(
      4,
      '#e07bff',
      `<circle r="16" ${white}/><circle r="4" fill="#ffffff"/><path d="M0,-24 V-10 M0,24 V10 M-24,0 H-10 M24,0 H10" ${white}/>`,
    ) +
    bolt(5, '#7ef0c0') +
    bolt(6, '#ff9a8a') +
    bolt(7, '#e07bff'),
);

const frames = {};
heroNames.forEach((name, i) => {
  frames[name] = { sheet: 'heroes', x: i * HERO, y: 0, w: HERO, h: HERO, radius: 32 };
});
objectNames.forEach((name, i) => {
  frames[name] = {
    sheet: 'objects',
    x: (i % 4) * CELL,
    y: Math.floor(i / 4) * CELL,
    w: CELL,
    h: CELL,
    radius: objectRadius[i],
  };
});

mkdirSync('art', { recursive: true });
mkdirSync('public/assets/sprites', { recursive: true });
writeFileSync('art/heroes.svg', heroes);
writeFileSync('art/objects.svg', objects);
writeFileSync('public/assets/sprites/atlas.json', JSON.stringify({ frames }, null, 2) + '\n');
console.log('art/heroes.svg, art/objects.svg, public/assets/sprites/atlas.json');
