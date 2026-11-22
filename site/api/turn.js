// Entrega servidores TURN (repetidor de voz/tela) pro app quando a conexão direta não rola.
// Usa o TURN gratuito da Cloudflare. Configure na Vercel (Settings → Environment Variables):
//   CF_TURN_KEY_ID     = "Turn Token ID" do painel da Cloudflare (Realtime → TURN Server)
//   CF_TURN_API_TOKEN  = "API Token" desse mesmo TURN
// Sem as variáveis, devolve lista vazia e o app segue só com conexão direta.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (!id || !token) return res.status(200).json({ iceServers: [], configured: false });
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) return res.status(200).json({ iceServers: [], configured: true, error: `cloudflare ${r.status}` });
    const data = await r.json();
    let list = data.iceServers || [];
    if (!Array.isArray(list)) list = [list];
    // a porta 53 costuma ser bloqueada por navegador/antivírus; tira pra não atrasar a conexão
    list = list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length);
    return res.status(200).json({ iceServers: list, configured: true });
  } catch (e) {
    return res.status(200).json({ iceServers: [], configured: true, error: String(e && e.message) });
  }
}
