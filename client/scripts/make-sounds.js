// Синтезує звукові ефекти у WAV (16 біт, моно) — без жодних сторонніх семплів.
//
//   npm run make-sounds

import { mkdirSync, writeFileSync } from 'node:fs';

const RATE = 22050;
const TAU = Math.PI * 2;

// Сіяний шум: файли виходять однакові при кожному запуску.
let seed = 12345;
function noise() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
}

function render(seconds, sampleAt) {
  const count = Math.floor(seconds * RATE);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = sampleAt(i / RATE, i / count);
  return samples;
}

function wav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); // розмір блоку fmt
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // моно
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28); // байтів за секунду
  buffer.writeUInt16LE(2, 32); // байтів на семпл
  buffer.writeUInt16LE(16, 34); // біт на семпл
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  });
  return buffer;
}

// Постріл: тон, що швидко сповзає вниз.
let phase = 0;
const shoot = render(0.18, (t, k) => {
  const frequency = 950 * (1 - k) ** 2 + 220;
  phase += (TAU * frequency) / RATE;
  return (Math.sin(phase) * 0.7 + Math.sign(Math.sin(phase)) * 0.15) * Math.exp(-t * 16) * 0.8;
});

// Влучання: короткий шум + низький удар.
const hit = render(0.14, (t) => {
  return (noise() * 0.6 * Math.exp(-t * 45) + Math.sin(TAU * 170 * t) * Math.exp(-t * 28)) * 0.8;
});

// Вибух: приглушений шум, що довго згасає, + гул.
let low = 0;
const explode = render(0.8, (t) => {
  low += (noise() - low) * 0.12; // однополюсний фільтр низьких частот
  return (low * 2.4 * Math.exp(-t * 4.5) + Math.sin(TAU * 55 * t) * 0.5 * Math.exp(-t * 6)) * 0.9;
});

// Руна: дві ноти вгору.
const pickup = render(0.36, (t) => {
  const frequency = t < 0.12 ? 660 : 990;
  const local = t < 0.12 ? t : t - 0.12;
  return (
    (Math.sin(TAU * frequency * t) + 0.3 * Math.sin(TAU * frequency * 2 * t)) *
    Math.exp(-local * 9) *
    0.5
  );
});

mkdirSync('public/assets/audio', { recursive: true });
for (const [name, samples] of Object.entries({ shoot, hit, explode, pickup })) {
  const file = `public/assets/audio/${name}.wav`;
  writeFileSync(file, wav(samples));
  console.log(file, `${(samples.length / RATE).toFixed(2)} с`);
}
