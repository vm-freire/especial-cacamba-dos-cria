<p align="center"><img src="build/icon.png" width="120" alt="ícone"/></p>

<h1 align="center">Especial Caçamba dos Cria</h1>
<p align="center">Chamada de voz, compartilhamento de tela e soundboard. Só pros cria.</p>

---

## ⬇️ Baixar (Windows)

**[Baixar a última versão](https://github.com/vm-freire/especial-cacamba-dos-cria/releases/latest/download/Especial-Cacamba-dos-Cria-Setup.exe)** e instale.

> O Windows pode mostrar "O Windows protegeu o computador" (o app não tem assinatura paga).
> Clique em **Mais informações → Executar assim mesmo**.

Depois de instalado, o app **se atualiza sozinho** quando sair versão nova.

## Como entrar

1. Abra o app e vá em **Criar conta**: apelido, e-mail e senha. Não precisa confirmar e-mail.
2. Clique no **+** da barra da esquerda e cole o **código do servidor** que te mandaram (ou crie o seu).
3. Entre numa sala de voz.

## O que tem

- 🎙️ **Voz** com supressão de ruído, cancelamento de eco, ganho automático e filtro de ruído (noise gate) com ajuste de sensibilidade
- 🎧 Escolha de **microfone** e **alto-falante**, volume de entrada/saída, **mutar** e **desativar áudio**
- 🖥️ **Compartilhar tela** ou uma janela/jogo, de 720p30 até resolução nativa a 60 FPS, com **áudio do PC**, modo jogo (fluidez) ou modo texto (nitidez), codec H.264 com aceleração da placa de vídeo, VP9, AV1 ou VP8
- 🔊 **Soundboard**: suba seus efeitos (até 700 KB / 30 s), clique e todo mundo na sala escuta
- 🔉 Volume individual de cada amigo e de cada transmissão (clique direito)
- ⌨️ Atalhos globais (funcionam dentro do jogo): `Ctrl+Shift+M` muta, `Ctrl+Shift+D` desativa o áudio
- 🏠 **Servidores** com salas de voz (crie, renomeie e exclua), convite por código
- 👥 **Amigos**: adicione e chame pro servidor com um clique
- 🔔 Sons de mutar, desmutar, entrar, sair e transmitir, estilo Discord

## Como funciona

Voz e tela vão **direto de um PC pro outro** (WebRTC peer-to-peer), sem servidor de mídia no meio: menos atraso.
O **Firebase** guarda só as contas, as salas, os sons e faz a "apresentação" entre os PCs.

Como cada pessoa assistindo recebe uma cópia direto de quem transmite, o upload de quem transmite importa:
1080p60 usa ~8 Mbps por pessoa assistindo. Se travar, baixe a qualidade no seletor de tela.

Se alguém não conseguir conectar (rede de faculdade, 4G, CGNAT), configure um servidor TURN em
**Configurações → Avançado** (ex.: o gratuito da metered.ca).

---

## Para desenvolvedores

```powershell
npm install
npm start          # roda o app
npm run dist       # gera o instalador em release/
```

**Publicar versão nova:** mude `version` no `package.json`, faça commit e crie uma tag:

```powershell
git tag v1.0.1
git push origin main --tags
```

O GitHub Actions gera o instalador e publica no Releases; os apps instalados se atualizam sozinhos.

**Site de download:** a pasta `site/` é publicada na Vercel.
