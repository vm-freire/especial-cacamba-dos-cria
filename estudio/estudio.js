// Estúdio de Vozes — tela
const E = window.estudio;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const fmtMB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');

function toast(msg, err = false) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (err) d.className = 'err';
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), err ? 7000 : 3500);
}

let estado = null;
let catalogo = { vozes: [] };
// voz sendo editada
let ed = null;

async function iniciar() {
  estado = await E.estado();
  $('#senha-box').hidden = estado.temSenha;
  $('#motor-box').hidden = estado.motor;
  $('#motor-ok').textContent = `Baixar motor (${fmtMB(estado.tamanhoMotor)})`;
  $('#status').textContent = [estado.motor ? 'motor pronto' : 'motor não baixado', estado.temSenha ? 'senha salva' : 'sem senha'].join(' · ');
  await carregarLista();
}

async function carregarLista() {
  $('#lista').innerHTML = '<div class="hint">Carregando…</div>';
  try {
    catalogo = await E.catalogo();
  } catch (e) {
    $('#lista').innerHTML = `<div class="hint">Não consegui ler o catálogo: ${esc(errMsg(e))}</div>`;
    return;
  }
  const vs = catalogo.vozes || [];
  $('#lista').innerHTML = vs.length
    ? vs
        .map(
          (v) => `<div class="item">
      ${v.fotoUrl ? `<img src="${v.fotoUrl}" alt=""/>` : `<div class="gen" style="--h:${[...v.nome].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}">${esc(v.nome.slice(0, 2))}</div>`}
      <div class="info"><b>${esc(v.nome)}</b><small class="muted">${fmtMB(v.modelo.tamanho)}${v.f0 ? ' · tom automático' : v.tom ? ` · ${v.tom > 0 ? '+' : ''}${v.tom} semitons` : ''}</small></div>
      <button data-editar="${esc(v.id)}">Editar</button>
      <button class="danger" data-apagar="${esc(v.id)}">Apagar</button>
    </div>`,
        )
        .join('')
    : '<div class="hint">Nenhuma voz publicada ainda. Clica em <b>+ Nova voz</b>.</div>';
}

// ---------- editor ----------
function abrirEditor(v) {
  ed = {
    id: v ? v.id : '',
    modelo: '', // caminho local do .onnx (novo)
    temModelo: !!v,
    foto: null, // bytes jpg novos
    fotoUrl: v ? v.fotoUrl || '' : '',
    semFoto: false,
    f0: v ? v.f0 || 0 : 160,
    tom: v ? v.tom || 0 : 0,
  };
  $('#editor').hidden = false;
  $('#ed-titulo').textContent = v ? `Editar "${v.nome}"` : 'Nova voz';
  $('#f-nome').value = v ? v.nome : '';
  $('#f-desc').value = v ? v.desc || '' : '';
  $('#f-tom').value = ed.tom;
  $('#f-modelo-info').textContent = v ? `o publicado (${fmtMB(v.modelo.tamanho)}) — escolha outro pra trocar` : 'nenhum';
  $('#t-orig').removeAttribute('src');
  $('#t-conv').removeAttribute('src');
  $('#t-info').textContent = '';
  mostrarFoto();
  mostrarTom();
}

function mostrarFoto() {
  $('#f-foto-prev').innerHTML = ed.fotoUrl ? `<img src="${ed.fotoUrl}" alt=""/>` : '<span>sem foto<br/><small>fica um cartão com o nome</small></span>';
}
function mostrarTom() {
  for (const b of document.querySelectorAll('.tomb')) b.classList.toggle('on', Number(b.dataset.f0) === ed.f0);
  $('#tom-wrap').hidden = !!ed.f0;
  $('#f0-info').textContent = ed.f0 ? `Tom alvo: ${ed.f0} Hz (ajusta sozinho pra cada pessoa)` : 'Tom fixo: use os semitons abaixo';
}

$('#nova').onclick = () => abrirEditor(null);
$('#cancelar').onclick = () => {
  $('#editor').hidden = true;
  ed = null;
};
$('#lista').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.editar) abrirEditor(catalogo.vozes.find((v) => v.id === b.dataset.editar));
  if (b.dataset.apagar) {
    const v = catalogo.vozes.find((x) => x.id === b.dataset.apagar);
    if (!confirm(`Apagar "${v.nome}" do Caçamba? Some pra todo mundo.`)) return;
    b.disabled = true;
    try {
      await E.apagar(v.id);
      toast('Voz apagada');
    } catch (err) {
      toast('Não deu pra apagar: ' + errMsg(err), true);
    }
    carregarLista();
  }
});

$('#f-modelo').onclick = async () => {
  if (!estado.motor) return toast('Baixa o motor primeiro (caixa à esquerda)', true);
  const f = await E.escolherArquivo('modelo');
  if (!f) return;
  $('#f-modelo-info').textContent = /\.pth$/i.test(f.nome) ? 'convertendo .pth… (1 a 3 min)' : 'carregando…';
  try {
    const r = await E.carregarModelo(f.path);
    ed.modelo = r.onnx;
    ed.temModelo = true;
    $('#f-modelo-info').textContent = `${f.nome} · ${fmtMB(r.tamanho)} · ${r.sr / 1000} kHz · ${r.gpu ? 'placa de vídeo' : 'processador'}`;
    if (!$('#f-nome').value) $('#f-nome').value = f.nome.replace(/\.(onnx|pth)$/i, '').replace(/[_-]+/g, ' ').slice(0, 40);
  } catch (e) {
    $('#f-modelo-info').textContent = 'não deu: ' + errMsg(e);
    toast(errMsg(e), true);
  }
};

for (const b of document.querySelectorAll('.tomb')) {
  b.onclick = () => {
    ed.f0 = Number(b.dataset.f0);
    mostrarTom();
  };
}
$('#f-tom').oninput = () => (ed.tom = Number($('#f-tom').value) || 0);

$('#f-ref').onclick = async () => {
  if (!estado.motor) return toast('Baixa o motor primeiro', true);
  const f = await E.escolherArquivo('audio');
  if (!f) return;
  try {
    const a16 = await decodificar16(f.bytes);
    const hz = await E.medianaF0(a16);
    if (!hz) return toast('Não achei voz nesse áudio', true);
    ed.f0 = hz;
    mostrarTom();
    toast(`Tom da voz original: ${hz} Hz`);
  } catch (e) {
    toast('Não consegui ler esse áudio: ' + errMsg(e), true);
  }
};

// foto: corta quadrada 320x320 jpg
async function fotoDeBlob(blob) {
  const img = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = c.height = 320;
  const s = Math.min(img.width, img.height);
  c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 320, 320);
  const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  ed.foto = new Uint8Array(await jpg.arrayBuffer());
  ed.fotoUrl = c.toDataURL('image/jpeg', 0.88);
  ed.semFoto = false;
  mostrarFoto();
}
$('#f-foto').onclick = async () => {
  const f = await E.escolherArquivo('foto');
  if (f) fotoDeBlob(new Blob([f.bytes])).catch((e) => toast('Imagem inválida: ' + errMsg(e), true));
};
$('#f-foto-tirar').onclick = () => {
  ed.foto = null;
  ed.fotoUrl = '';
  ed.semFoto = true;
  mostrarFoto();
};

// ---------- teste ----------
async function decodificar16(bytes) {
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}
function wavUrl(f32, sr) {
  const b = new ArrayBuffer(44 + f32.length * 2);
  const v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + f32.length * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
async function rodarTeste(a16) {
  if (!ed.modelo && !ed.temModelo) return toast('Escolhe o modelo primeiro', true);
  if (!ed.modelo) return toast('Pra testar, escolha o arquivo do modelo de novo (o publicado não fica neste PC)', true);
  $('#t-orig').src = wavUrl(a16, 16000);
  $('#t-info').textContent = 'Convertendo…';
  try {
    const r = await E.testar({ modelo: ed.modelo, audio16: a16, tom: ed.tom, f0: ed.f0 });
    $('#t-conv').src = wavUrl(new Float32Array(r.audio), 48000);
    $('#t-conv').play();
    const rt = (r.ms / 1000 / r.segundos) * 100;
    $('#t-info').textContent = `${r.tran > 0 ? '+' : ''}${r.tran} semitons${r.userF0 ? ` (sua voz ~${r.userF0} Hz)` : ''} · usou ${rt.toFixed(0)}% do tempo real ${rt < 60 ? '✓' : '— lento, pode engasgar'}`;
  } catch (e) {
    $('#t-info').textContent = '';
    toast('O teste falhou: ' + errMsg(e), true);
  }
}
$('#t-gravar').onclick = async () => {
  if (!ed.modelo) return toast('Escolhe o modelo primeiro', true);
  const b = $('#t-gravar');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    return toast('Não consegui abrir o microfone', true);
  }
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const pedacos = [];
  proc.onaudioprocess = (e) => pedacos.push(e.inputBuffer.getChannelData(0).slice());
  src.connect(proc);
  proc.connect(ctx.destination);
  b.disabled = true;
  for (let s = 6; s > 0; s--) {
    b.textContent = `● Gravando… ${s}`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  proc.disconnect();
  src.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close();
  b.disabled = false;
  b.textContent = '● Gravar 6 s do microfone';
  const n = pedacos.reduce((a, p) => a + p.length, 0);
  const a48 = new Float32Array(n);
  let o = 0;
  for (const p of pedacos) {
    a48.set(p, o);
    o += p.length;
  }
  // 48k -> 16k
  const off = new OfflineAudioContext(1, Math.ceil(n / 3), 16000);
  const ab = off.createBuffer(1, n, 48000);
  ab.copyToChannel(a48, 0);
  const s2 = off.createBufferSource();
  s2.buffer = ab;
  s2.connect(off.destination);
  s2.start();
  rodarTeste((await off.startRendering()).getChannelData(0).slice());
};
$('#t-arquivo').onclick = async () => {
  if (!ed.modelo) return toast('Escolhe o modelo primeiro', true);
  const f = await E.escolherArquivo('audio');
  if (!f) return;
  try {
    rodarTeste(await decodificar16(f.bytes));
  } catch (e) {
    toast('Não consegui ler esse áudio: ' + errMsg(e), true);
  }
};

// ---------- publicar ----------
$('#publicar').onclick = async () => {
  const nome = $('#f-nome').value.trim();
  if (!nome) return toast('Dá um nome pra voz', true);
  if (!ed.temModelo) return toast('Escolhe o modelo da voz', true);
  if (!estado.temSenha) {
    $('#senha-box').hidden = false;
    return toast('Coloca a senha de publicação primeiro', true);
  }
  const b = $('#publicar');
  b.disabled = true;
  b.textContent = 'Publicando…';
  try {
    const v = await E.publicar({ id: ed.id, nome, desc: $('#f-desc').value, tom: ed.tom, f0: ed.f0, modelo: ed.modelo || null, foto: ed.foto, semFoto: ed.semFoto });
    toast(`"${v.nome}" publicada! Os amigos clicam em Atualizar vozes.`);
    $('#editor').hidden = true;
    ed = null;
    carregarLista();
  } catch (e) {
    toast('Não deu pra publicar: ' + errMsg(e), true);
    if (/senha/.test(errMsg(e))) $('#senha-box').hidden = false;
  }
  b.disabled = false;
  b.textContent = 'Publicar no Caçamba';
};

E.onProg((d) => {
  if (d.tipo === 'motor') {
    const p = $('#motor-box .prog');
    p.hidden = false;
    p.firstElementChild.style.width = (d.p * 100).toFixed(1) + '%';
    $('#motor-ok').textContent = `Baixando… ${Math.floor(d.p * 100)}%`;
  } else if (d.tipo === 'pub') {
    $('#publicar').textContent = d.p != null && d.p < 1 ? `${d.msg} ${Math.floor(d.p * 100)}%` : d.msg;
  } else if (d.tipo === 'pth') {
    $('#f-modelo-info').textContent = d.msg;
  }
});

$('#motor-ok').onclick = async () => {
  $('#motor-ok').disabled = true;
  try {
    await E.instalarMotor();
    toast('Motor pronto!');
  } catch (e) {
    toast('Não deu pra baixar o motor: ' + errMsg(e), true);
  }
  $('#motor-ok').disabled = false;
  iniciar();
};

$('#btn-senha').onclick = () => ($('#senha-box').hidden = !$('#senha-box').hidden);
$('#senha-ok').onclick = async () => {
  const s = $('#senha-in').value;
  if (!s) return;
  $('#senha-ok').disabled = true;
  try {
    await E.senha(s);
    $('#senha-in').value = '';
    toast('Senha certa, salva neste PC');
    iniciar();
  } catch (e) {
    toast(errMsg(e), true);
  }
  $('#senha-ok').disabled = false;
};

iniciar();
