// copia o RNNoise (supressão de ruído por IA) pro dist/: o worklet e o wasm são carregados em tempo de execução
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist');
const out = path.join(__dirname, '..', 'dist', 'rnnoise');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(src, 'rnnoise', 'workletProcessor.js'), path.join(out, 'workletProcessor.js'));
for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm']) fs.copyFileSync(path.join(src, f), path.join(out, f));

// motor do autotune (filtro de voz "Autotune")
const at = path.join(__dirname, '..', 'dist', 'autotune');
fs.mkdirSync(at, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'src', 'vendor', 'autotune-igao', 'autotune-processor.js'), path.join(at, 'autotune-processor.js'));

// ponte do áudio das vozes com IA (worklet que junta pedaços e toca a voz convertida)
const vi = path.join(__dirname, '..', 'dist', 'vozia');
fs.mkdirSync(vi, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'src', 'vendor', 'voz-ia-processor.js'), path.join(vi, 'voz-ia-processor.js'));
